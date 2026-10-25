#include "gateway.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <esp_random.h>

#include "config.h"

extern const char rootCaStart[] asm("_binary_certs_root_ca_pem_start");

namespace {

constexpr uint8_t kOpText = 0x1;
constexpr uint8_t kOpBinary = 0x2;

class Locked {
 public:
  explicit Locked(SemaphoreHandle_t lock) : lock_(lock) { xSemaphoreTake(lock_, portMAX_DELAY); }
  ~Locked() { xSemaphoreGive(lock_); }

 private:
  SemaphoreHandle_t lock_;
};

void copyText(char* target, size_t capacity, const char* source) {
  strlcpy(target, source ? source : "", capacity);
}

}  // namespace

bool Gateway::begin(const Settings& settings) {
  events_ = xQueueCreate(16, sizeof(GatewayEvent));
  gateLock_ = xSemaphoreCreateMutex();
  if (!events_ || !gateLock_) return false;
  snprintf(uri_, sizeof uri_, "wss://%s:%u%s", settings.host, settings.port, settings.path);
  snprintf(headers_, sizeof headers_, "Authorization: Bearer %s\r\n", settings.token);

  esp_websocket_client_config_t config = {};
  config.uri = uri_;
  config.headers = headers_;
  config.cert_pem = rootCaStart;
  config.disable_auto_reconnect = true;
  config.buffer_size = config::kWebSocketBufferBytes;
  config.task_stack = 6144;
  config.keep_alive_enable = true;
  config.ping_interval_sec = 10;
  config.pingpong_timeout_sec = 25;
  client_ = esp_websocket_client_init(&config);
  if (!client_) return false;
  return esp_websocket_register_events(client_, WEBSOCKET_EVENT_ANY, onEvent, this) == ESP_OK;
}

void Gateway::tick(uint32_t nowMs, bool networkUp) {
  if (!client_) return;
  if (!networkUp) {
    if (started_) {
      esp_websocket_client_stop(client_);
      started_ = false;
      markDisconnected();
      attempt_ = 0;
    }
    return;
  }
  const bool stalled = started_ && !connected_ && nowMs - startedAtMs_ > config::kConnectTimeoutMs;
  if (started_ && (dropped_ || stalled)) {
    esp_websocket_client_stop(client_);
    dropped_ = false;
    started_ = false;
    markDisconnected();
    scheduleReconnect(nowMs);
  }
  if (!started_ && static_cast<int32_t>(nowMs - retryAtMs_) >= 0) {
    if (attempt_ > 0) ++reconnects_;
    dropped_ = false;
    esp_websocket_client_start(client_);
    started_ = true;
    startedAtMs_ = nowMs;
  }
}

void Gateway::markDisconnected() {
  if (!connected_.exchange(false)) return;
  GatewayEvent event = {};
  event.type = GatewayEventType::Disconnected;
  post(event);
}

void Gateway::scheduleReconnect(uint32_t nowMs) {
  retryAtMs_ = nowMs + protocol::reconnectDelayMs(attempt_++, esp_random());
}

bool Gateway::poll(GatewayEvent& out) {
  return events_ && xQueueReceive(events_, &out, 0) == pdTRUE;
}

bool Gateway::sendText(const char* json, size_t length) {
  if (!connected_ || esp_websocket_client_send_text(client_, json, length, pdMS_TO_TICKS(1000)) < 0) {
    ++sendFailures_;
    return false;
  }
  return true;
}

bool Gateway::sendMicrophone(const protocol::TurnId& turn, const uint8_t* pcm, size_t size) {
  if (!connected_ || size > sizeof micFrame_ - protocol::kFrameHeaderBytes) return false;
  protocol::writeMicHeader(turn, micFrame_);
  memcpy(micFrame_ + protocol::kFrameHeaderBytes, pcm, size);
  const int sent = esp_websocket_client_send_bin(client_, reinterpret_cast<const char*>(micFrame_), protocol::kFrameHeaderBytes + size, pdMS_TO_TICKS(200));
  if (sent < 0) ++sendFailures_;
  return sent >= 0;
}

void Gateway::armTurn(const protocol::TurnId& turn) {
  Locked guard(gateLock_);
  gate_.arm(turn);
}

void Gateway::cancelTurn() {
  Locked guard(gateLock_);
  gate_.cancel();
}

uint32_t Gateway::droppedReplyFrames() {
  Locked guard(gateLock_);
  return gate_.dropped();
}

void Gateway::post(const GatewayEvent& event) {
  if (xQueueSend(events_, &event, 0) != pdTRUE) ++droppedEvents_;
}

void Gateway::onEvent(void* self, esp_event_base_t, int32_t id, void* data) {
  Gateway& gateway = *static_cast<Gateway*>(self);
  GatewayEvent event = {};
  switch (id) {
    case WEBSOCKET_EVENT_CONNECTED:
      gateway.connected_ = true;
      gateway.attempt_ = 0;
      event.type = GatewayEventType::Connected;
      gateway.post(event);
      break;
    case WEBSOCKET_EVENT_ERROR:
    case WEBSOCKET_EVENT_DISCONNECTED:
    case WEBSOCKET_EVENT_CLOSED:
      gateway.markDisconnected();
      gateway.dropped_ = true;
      break;
    case WEBSOCKET_EVENT_DATA:
      gateway.onData(*static_cast<esp_websocket_event_data_t*>(data));
      break;
    default:
      break;
  }
}

void Gateway::onData(const esp_websocket_event_data_t& data) {
  if (data.op_code == kOpBinary) onBinary(data);
  else if (data.op_code == kOpText) onText(data);
}

void Gateway::onBinary(const esp_websocket_event_data_t& data) {
  size_t played = 0;
  {
    Locked guard(gateLock_);
    played = gate_.filter(reinterpret_cast<const uint8_t*>(data.data_ptr), data.data_len, data.payload_offset, scratch_);
  }
  if (played == 0) return;
  audio_.writePlayback(scratch_, played);
  waitForPlaybackRoom();
}

void Gateway::waitForPlaybackRoom() {
  const uint32_t startedAt = millis();
  while (connected_ && audio_.playbackAboveHighWater() && millis() - startedAt < config::kBackpressureMaxWaitMs) vTaskDelay(pdMS_TO_TICKS(5));
}

void Gateway::onText(const esp_websocket_event_data_t& data) {
  if (data.payload_offset != 0 || data.payload_len > static_cast<int>(config::kMaxTextMessageBytes) || data.data_len != data.payload_len) return;
  JsonDocument doc;
  if (deserializeJson(doc, data.data_ptr, data.data_len) != DeserializationError::Ok) return;
  const char* type = doc["type"] | "";
  GatewayEvent event = {};
  event.hasTurn = doc["turnId"].is<const char*>() && protocol::parseTurnId(doc["turnId"], event.turn);
  if (strcmp(type, "ready") == 0) {
    event.type = GatewayEventType::Ready;
    copyText(event.conversationId, sizeof event.conversationId, doc["conversationId"]);
  } else if (strcmp(type, "audio.begin") == 0 && event.hasTurn) {
    Locked guard(gateLock_);
    gate_.beginReply(event.turn);
    event.type = GatewayEventType::ReplyBegin;
  } else if (strcmp(type, "audio.end") == 0 && event.hasTurn) {
    Locked guard(gateLock_);
    gate_.endReply(event.turn);
    event.type = GatewayEventType::ReplyEnd;
    copyText(event.detail, sizeof event.detail, doc["reason"]);
  } else if (strcmp(type, "turn.end") == 0 && event.hasTurn) {
    event.type = GatewayEventType::TurnEnd;
    copyText(event.detail, sizeof event.detail, doc["status"]);
  } else if (strcmp(type, "error") == 0) {
    event.type = GatewayEventType::Error;
    copyText(event.detail, sizeof event.detail, doc["code"]);
  } else {
    return;
  }
  post(event);
}

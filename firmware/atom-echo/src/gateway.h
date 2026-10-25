#pragma once

#include <Arduino.h>

#include <atomic>
#include <cstdint>

#include <esp_websocket_client.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>

#include "audio_io.h"
#include "config.h"
#include "protocol.h"
#include "settings.h"

enum class GatewayEventType : uint8_t { Connected, Disconnected, Ready, ReplyBegin, ReplyEnd, TurnEnd, Error };

struct GatewayEvent {
  GatewayEventType type;
  bool hasTurn;
  protocol::TurnId turn;
  char conversationId[protocol::kUuidTextBytes];
  char detail[24];
};

/**
 * TLS WebSocket client for `GET /ws/device`. Server messages are turned into small events for the main
 * loop; binary reply frames go through the turn gate straight into the playback buffer.
 * Reconnection is driven from tick() with exponential backoff.
 */
class Gateway {
 public:
  explicit Gateway(AudioIo& audio) : audio_(audio) {}

  bool begin(const Settings& settings);
  void tick(uint32_t nowMs, bool networkUp);
  bool poll(GatewayEvent& out);

  bool connected() const { return connected_; }
  bool sendText(const char* json, size_t length);
  bool sendMicrophone(const protocol::TurnId& turn, const uint8_t* pcm, size_t size);

  void armTurn(const protocol::TurnId& turn);
  void cancelTurn();

  uint32_t reconnects() const { return reconnects_; }
  uint32_t droppedReplyFrames();
  uint32_t droppedEvents() const { return droppedEvents_; }
  uint32_t sendFailures() const { return sendFailures_; }

 private:
  static void onEvent(void* self, esp_event_base_t base, int32_t id, void* data);
  void onData(const esp_websocket_event_data_t& data);
  void onBinary(const esp_websocket_event_data_t& data);
  void onText(const esp_websocket_event_data_t& data);
  void post(const GatewayEvent& event);
  void waitForPlaybackRoom();
  void markDisconnected();
  void scheduleReconnect(uint32_t nowMs);

  AudioIo& audio_;
  esp_websocket_client_handle_t client_ = nullptr;
  QueueHandle_t events_ = nullptr;
  SemaphoreHandle_t gateLock_ = nullptr;
  protocol::ReplyGate gate_;
  char uri_[160] = "";
  char headers_[96] = "";
  uint8_t scratch_[config::kWebSocketBufferBytes + 1];
  uint8_t micFrame_[protocol::kFrameHeaderBytes + config::kFrameBytes * 2];

  std::atomic<bool> connected_{false};
  std::atomic<bool> dropped_{false};
  bool started_ = false;
  uint32_t attempt_ = 0;
  uint32_t startedAtMs_ = 0;
  uint32_t retryAtMs_ = 0;
  uint32_t reconnects_ = 0;
  volatile uint32_t droppedEvents_ = 0;
  volatile uint32_t sendFailures_ = 0;
};

#include <Arduino.h>
#include <WiFi.h>
#include <time.h>

#include "assistant.h"
#include "audio_io.h"
#include "button.h"
#include "config.h"
#include "console.h"
#include "gateway.h"
#include "led.h"
#include "settings.h"

namespace {

constexpr time_t kClockValidAfter = 1700000000;

Settings settings;
Led led;
Button button;
AudioIo audio;
Gateway gateway(audio);
Assistant assistant(gateway, audio, led);
bool gatewayReady = false;
bool wifiStarted = false;
uint32_t wifiAttemptMs = 0;

void printStats() {
  Serial.printf("state=%d connected=%d reconnects=%u\n", static_cast<int>(assistant.state()), gateway.connected(), gateway.reconnects());
  Serial.printf("capture_overruns=%u playback_overruns=%u playback_underruns=%u\n", audio.captureOverruns(), audio.playbackOverruns(),
                assistant.underruns());
  Serial.printf("dropped_reply_frames=%u dropped_events=%u send_failures=%u\n", gateway.droppedReplyFrames(), gateway.droppedEvents(),
                gateway.sendFailures());
  Serial.printf("free_heap=%u largest_block=%u rssi=%d\n", ESP.getFreeHeap(), ESP.getMaxAllocHeap(), WiFi.RSSI());
}

Console console(settings, printStats);

bool clockValid() {
  return time(nullptr) > kClockValidAfter;
}

void connectWifi(uint32_t nowMs) {
  if (!settings.complete()) return;
  if (!wifiStarted) {
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    configTime(0, 0, "pool.ntp.org", "time.google.com");
    wifiStarted = true;
    wifiAttemptMs = nowMs;
    WiFi.begin(settings.ssid, settings.password);
  } else if (WiFi.status() != WL_CONNECTED && nowMs - wifiAttemptMs >= config::kWifiRetryMs) {
    wifiAttemptMs = nowMs;
    WiFi.reconnect();
  }
}

}  // namespace

void setup() {
  Serial.begin(115200);
  settings.load();
  button.begin();
  audio.begin();
  Serial.printf("jarvis atom-echo %s\n", config::kFirmwareVersion);
  if (!settings.complete()) Serial.println("not provisioned: use wifi, server and token, then reboot");
}

void loop() {
  const uint32_t now = millis();
  console.poll();
  connectWifi(now);
  const bool networkUp = WiFi.status() == WL_CONNECTED && clockValid();
  if (networkUp && !gatewayReady) gatewayReady = gateway.begin(settings);
  gateway.tick(now, networkUp && gatewayReady);
  assistant.update(now, button.poll(now));
  led.tick(now);
  delay(1);
}

#pragma once

#include <cstddef>
#include <cstdint>

namespace config {

constexpr const char* kFirmwareVersion = "0.1.0";

constexpr int kLedPin = 27;
constexpr int kButtonPin = 39;
constexpr bool kButtonActiveLow = true;
constexpr int kI2sBitClockPin = 19;
constexpr int kI2sWordClockPin = 33;
constexpr int kSpeakerDataPin = 22;
constexpr int kMicDataPin = 23;

constexpr uint32_t kSampleRate = 16000;
constexpr size_t kFrameMs = 20;
constexpr size_t kFrameBytes = kSampleRate / 1000 * kFrameMs * 2;

constexpr size_t kCaptureBufferBytes = kSampleRate * 2;
constexpr size_t kPlaybackBufferBytes = kSampleRate * 2 * 2;
constexpr size_t kPlaybackHighWaterBytes = kPlaybackBufferBytes * 3 / 4;
constexpr uint32_t kBackpressureMaxWaitMs = 2000;

constexpr int kMicGainShift = 2;
constexpr int kSpeakerVolumePercent = 40;

constexpr uint32_t kDebounceMs = 30;
constexpr uint32_t kMinUtteranceMs = 200;
constexpr uint32_t kMaxUtteranceMs = 30000;
constexpr uint32_t kThinkingTimeoutMs = 60000;
constexpr uint32_t kErrorDisplayMs = 2000;

constexpr uint32_t kWifiRetryMs = 30000;
constexpr uint32_t kClockSyncTimeoutMs = 20000;
constexpr uint32_t kConnectTimeoutMs = 20000;
constexpr size_t kMaxTextMessageBytes = 1024;
constexpr size_t kWebSocketBufferBytes = 2048;

}  // namespace config

#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>

#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/stream_buffer.h>

/**
 * Owns the single I2S port. PDM capture and speaker playback share pin G33 as clock, so the port is
 * half duplex: the audio task reinstalls the driver whenever the requested mode changes.
 * Both directions go through bounded stream buffers; nothing here blocks the network task.
 */
class AudioIo {
 public:
  enum class Mode : uint8_t { Idle, Capture, Playback };

  bool begin();
  void setMode(Mode mode);
  Mode mode() const { return static_cast<Mode>(active_.load()); }

  size_t readCaptured(uint8_t* out, size_t maxBytes);
  size_t writePlayback(const uint8_t* pcm, size_t size);
  bool playbackAboveHighWater();
  bool playbackDrained();

  uint32_t captureOverruns() const { return captureOverruns_; }
  uint32_t playbackOverruns() const { return playbackOverruns_; }

 private:
  static void taskEntry(void* self);
  void run();
  bool install(Mode mode);
  void flush(bool includingPlayback);
  void captureChunk(uint8_t* chunk);
  void playChunk(uint8_t* chunk);

  StreamBufferHandle_t capture_ = nullptr;
  StreamBufferHandle_t playback_ = nullptr;
  SemaphoreHandle_t lock_ = nullptr;
  std::atomic<uint8_t> requested_{static_cast<uint8_t>(Mode::Idle)};
  std::atomic<uint8_t> active_{static_cast<uint8_t>(Mode::Idle)};
  std::atomic<bool> playing_{false};
  std::atomic<uint32_t> lastWriteMs_{0};
  volatile uint32_t captureOverruns_ = 0;
  volatile uint32_t playbackOverruns_ = 0;
};

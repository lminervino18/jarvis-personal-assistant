#include "audio_io.h"

#include <Arduino.h>
#include <driver/i2s.h>

#include "config.h"

namespace {

constexpr i2s_port_t kPort = I2S_NUM_0;
constexpr int kDmaBufferCount = 8;
constexpr int kDmaBufferSamples = 256;
constexpr uint32_t kDmaTailMs = kDmaBufferCount * kDmaBufferSamples * 1000 / config::kSampleRate + 20;

class Locked {
 public:
  explicit Locked(SemaphoreHandle_t lock) : lock_(lock) { xSemaphoreTake(lock_, portMAX_DELAY); }
  ~Locked() { xSemaphoreGive(lock_); }

 private:
  SemaphoreHandle_t lock_;
};

int16_t saturate(int32_t value) {
  return static_cast<int16_t>(value > INT16_MAX ? INT16_MAX : value < INT16_MIN ? INT16_MIN : value);
}

}  // namespace

bool AudioIo::begin() {
  capture_ = xStreamBufferCreate(config::kCaptureBufferBytes, 1);
  playback_ = xStreamBufferCreate(config::kPlaybackBufferBytes, 1);
  lock_ = xSemaphoreCreateMutex();
  if (!capture_ || !playback_ || !lock_) return false;
  return xTaskCreatePinnedToCore(taskEntry, "audio", 4096, this, 3, nullptr, 1) == pdPASS;
}

void AudioIo::setMode(Mode mode) {
  requested_ = static_cast<uint8_t>(mode);
}

size_t AudioIo::readCaptured(uint8_t* out, size_t maxBytes) {
  Locked guard(lock_);
  return xStreamBufferReceive(capture_, out, maxBytes, 0);
}

size_t AudioIo::writePlayback(const uint8_t* pcm, size_t size) {
  Locked guard(lock_);
  const size_t sent = xStreamBufferSend(playback_, pcm, size, 0);
  if (sent < size) ++playbackOverruns_;
  return sent;
}

bool AudioIo::playbackAboveHighWater() {
  Locked guard(lock_);
  return xStreamBufferBytesAvailable(playback_) >= config::kPlaybackHighWaterBytes;
}

bool AudioIo::playbackDrained() {
  Locked guard(lock_);
  return xStreamBufferIsEmpty(playback_) == pdTRUE && !playing_;
}

void AudioIo::taskEntry(void* self) {
  static_cast<AudioIo*>(self)->run();
}

void AudioIo::run() {
  uint8_t chunk[config::kFrameBytes];
  for (;;) {
    const Mode wanted = static_cast<Mode>(requested_.load());
    if (wanted != mode()) {
      install(wanted);
      flush(wanted != Mode::Playback);
      active_ = static_cast<uint8_t>(wanted);
    }
    switch (mode()) {
      case Mode::Capture: captureChunk(chunk); break;
      case Mode::Playback: playChunk(chunk); break;
      case Mode::Idle: vTaskDelay(pdMS_TO_TICKS(10)); break;
    }
  }
}

bool AudioIo::install(Mode mode) {
  i2s_driver_uninstall(kPort);
  if (mode == Mode::Idle) return true;
  const bool capturing = mode == Mode::Capture;
  i2s_config_t config = {};
  config.mode = static_cast<i2s_mode_t>(capturing ? (I2S_MODE_MASTER | I2S_MODE_RX | I2S_MODE_PDM) : (I2S_MODE_MASTER | I2S_MODE_TX));
  config.sample_rate = config::kSampleRate;
  config.bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT;
  config.channel_format = I2S_CHANNEL_FMT_ALL_RIGHT;
  config.communication_format = I2S_COMM_FORMAT_STAND_I2S;
  config.intr_alloc_flags = ESP_INTR_FLAG_LEVEL1;
  config.dma_buf_count = kDmaBufferCount;
  config.dma_buf_len = kDmaBufferSamples;
  config.tx_desc_auto_clear = !capturing;
  if (i2s_driver_install(kPort, &config, 0, nullptr) != ESP_OK) return false;
  i2s_pin_config_t pins = {};
  pins.mck_io_num = I2S_PIN_NO_CHANGE;
  pins.bck_io_num = capturing ? I2S_PIN_NO_CHANGE : config::kI2sBitClockPin;
  pins.ws_io_num = config::kI2sWordClockPin;
  pins.data_out_num = capturing ? I2S_PIN_NO_CHANGE : config::kSpeakerDataPin;
  pins.data_in_num = capturing ? config::kMicDataPin : I2S_PIN_NO_CHANGE;
  if (i2s_set_pin(kPort, &pins) != ESP_OK) return false;
  i2s_zero_dma_buffer(kPort);
  return true;
}

void AudioIo::flush(bool includingPlayback) {
  Locked guard(lock_);
  xStreamBufferReset(capture_);
  if (!includingPlayback) return;
  xStreamBufferReset(playback_);
  playing_ = false;
}

void AudioIo::captureChunk(uint8_t* chunk) {
  size_t read = 0;
  if (i2s_read(kPort, chunk, config::kFrameBytes, &read, pdMS_TO_TICKS(40)) != ESP_OK || read == 0) return;
  int16_t* samples = reinterpret_cast<int16_t*>(chunk);
  for (size_t i = 0; i < read / 2; i++) samples[i] = saturate(static_cast<int32_t>(samples[i]) << config::kMicGainShift);
  Locked guard(lock_);
  if (xStreamBufferSend(capture_, chunk, read, 0) < read) ++captureOverruns_;
}

void AudioIo::playChunk(uint8_t* chunk) {
  size_t size = 0;
  {
    Locked guard(lock_);
    size = xStreamBufferReceive(playback_, chunk, config::kFrameBytes, 0);
    if (size > 0) playing_ = true;
    else if (playing_ && millis() - lastWriteMs_ > kDmaTailMs) playing_ = false;
  }
  if (size == 0) {
    vTaskDelay(pdMS_TO_TICKS(2));
    return;
  }
  int16_t* samples = reinterpret_cast<int16_t*>(chunk);
  for (size_t i = 0; i < size / 2; i++) samples[i] = static_cast<int16_t>(samples[i] * config::kSpeakerVolumePercent / 100);
  size_t written = 0;
  i2s_write(kPort, chunk, size, &written, portMAX_DELAY);
  lastWriteMs_ = millis();
}

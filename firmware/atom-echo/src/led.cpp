#include "led.h"

#include <Arduino.h>

#include "config.h"

namespace {

struct Rgb {
  uint8_t r, g, b;
};

Rgb solid(LedState state) {
  switch (state) {
    case LedState::Idle: return {0, 0, 12};
    case LedState::Listening: return {0, 60, 0};
    case LedState::Speaking: return {0, 40, 40};
    case LedState::Error: return {60, 0, 0};
    default: return {0, 0, 0};
  }
}

Rgb animated(LedState state, uint32_t nowMs) {
  if (state == LedState::Connecting) return (nowMs / 500) % 2 ? Rgb{0, 0, 0} : Rgb{50, 20, 0};
  const uint32_t phase = nowMs % 1000;
  const uint32_t level = phase < 500 ? phase : 1000 - phase;
  const uint8_t scale = static_cast<uint8_t>(10 + level * 50 / 500);
  return {scale, static_cast<uint8_t>(scale * 2 / 3), 0};
}

}  // namespace

void Led::tick(uint32_t nowMs) {
  if (nowMs - lastDrawMs_ < 40) return;
  lastDrawMs_ = nowMs;
  const bool moving = state_ == LedState::Connecting || state_ == LedState::Thinking;
  const Rgb color = moving ? animated(state_, nowMs) : solid(state_);
  const uint32_t packed = (color.r << 16) | (color.g << 8) | color.b;
  if (packed == lastColor_) return;
  lastColor_ = packed;
  neopixelWrite(config::kLedPin, color.r, color.g, color.b);
}

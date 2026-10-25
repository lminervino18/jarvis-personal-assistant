#pragma once

#include <Arduino.h>

#include "config.h"

enum class ButtonEvent : uint8_t { None, Pressed, Released };

/** Debounced push-to-talk button on GPIO39 (input only, no internal pull resistor). */
class Button {
 public:
  void begin() { pinMode(config::kButtonPin, INPUT); }

  ButtonEvent poll(uint32_t nowMs) {
    const bool raw = (digitalRead(config::kButtonPin) == LOW) == config::kButtonActiveLow;
    if (raw != candidate_) {
      candidate_ = raw;
      changedAtMs_ = nowMs;
      return ButtonEvent::None;
    }
    if (candidate_ == stable_ || nowMs - changedAtMs_ < config::kDebounceMs) return ButtonEvent::None;
    stable_ = candidate_;
    return stable_ ? ButtonEvent::Pressed : ButtonEvent::Released;
  }

 private:
  bool candidate_ = false;
  bool stable_ = false;
  uint32_t changedAtMs_ = 0;
};

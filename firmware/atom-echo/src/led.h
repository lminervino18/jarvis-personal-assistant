#pragma once

#include <cstdint>

enum class LedState : uint8_t { Connecting, Idle, Listening, Thinking, Speaking, Error };

/** Drives the single SK6812 LED; Connecting blinks and Thinking pulses, the rest are solid. */
class Led {
 public:
  void set(LedState state) { state_ = state; }
  void tick(uint32_t nowMs);

 private:
  LedState state_ = LedState::Connecting;
  uint32_t lastDrawMs_ = 0;
  uint32_t lastColor_ = 0xFFFFFFFF;
};

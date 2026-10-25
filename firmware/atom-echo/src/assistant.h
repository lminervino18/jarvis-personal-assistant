#pragma once

#include <cstdint>

#include "audio_io.h"
#include "button.h"
#include "gateway.h"
#include "led.h"

enum class AssistantState : uint8_t { Offline, Idle, Listening, Thinking, Speaking, Error };

/**
 * Turn-based push-to-talk state machine: hold the button to speak, the reply plays through the speaker,
 * pressing during thinking or speaking cancels the turn. Half duplex by design.
 */
class Assistant {
 public:
  Assistant(Gateway& gateway, AudioIo& audio, Led& led) : gateway_(gateway), audio_(audio), led_(led) {}

  void update(uint32_t nowMs, ButtonEvent button);
  AssistantState state() const { return state_; }
  uint32_t underruns() const { return underruns_; }

 private:
  void onGatewayEvent(const GatewayEvent& event, uint32_t nowMs);
  void onButton(ButtonEvent button, uint32_t nowMs);
  void startTurn(uint32_t nowMs);
  void streamMicrophone();
  void finishListening(uint32_t nowMs);
  void cancelTurn();
  void abortTurn();
  void enter(AssistantState state, uint32_t nowMs);
  bool isActiveTurn(const GatewayEvent& event) const;

  Gateway& gateway_;
  AudioIo& audio_;
  Led& led_;
  AssistantState state_ = AssistantState::Offline;
  protocol::TurnId turn_{};
  bool turnActive_ = false;
  bool replyEnded_ = false;
  char conversationId_[protocol::kUuidTextBytes] = "";
  uint32_t enteredAtMs_ = 0;
  uint32_t micBytes_ = 0;
  uint32_t underruns_ = 0;
};

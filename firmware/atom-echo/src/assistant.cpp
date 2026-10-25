#include "assistant.h"

#include <Arduino.h>
#include <esp_random.h>

#include "config.h"

namespace {

LedState ledFor(AssistantState state) {
  switch (state) {
    case AssistantState::Idle: return LedState::Idle;
    case AssistantState::Listening: return LedState::Listening;
    case AssistantState::Thinking: return LedState::Thinking;
    case AssistantState::Speaking: return LedState::Speaking;
    case AssistantState::Error: return LedState::Error;
    default: return LedState::Connecting;
  }
}

uint32_t millisOfAudio(uint32_t bytes) {
  return bytes / 2 * 1000 / config::kSampleRate;
}

}  // namespace

void Assistant::update(uint32_t nowMs, ButtonEvent button) {
  GatewayEvent event;
  while (gateway_.poll(event)) onGatewayEvent(event, nowMs);
  onButton(button, nowMs);

  const uint32_t elapsed = nowMs - enteredAtMs_;
  switch (state_) {
    case AssistantState::Listening:
      streamMicrophone();
      if (elapsed >= config::kMaxUtteranceMs) finishListening(nowMs);
      break;
    case AssistantState::Thinking:
      if (elapsed >= config::kThinkingTimeoutMs) {
        cancelTurn();
        enter(AssistantState::Error, nowMs);
      }
      break;
    case AssistantState::Speaking:
      if (replyEnded_ && audio_.playbackDrained()) {
        abortTurn();
        enter(AssistantState::Idle, nowMs);
      } else if (!replyEnded_ && audio_.playbackDrained()) {
        ++underruns_;
      }
      break;
    case AssistantState::Error:
      if (elapsed >= config::kErrorDisplayMs) enter(gateway_.connected() ? AssistantState::Idle : AssistantState::Offline, nowMs);
      break;
    default:
      break;
  }
}

void Assistant::enter(AssistantState state, uint32_t nowMs) {
  state_ = state;
  enteredAtMs_ = nowMs;
  led_.set(ledFor(state));
}

bool Assistant::isActiveTurn(const GatewayEvent& event) const {
  return turnActive_ && event.hasTurn && protocol::sameTurn(event.turn, turn_);
}

void Assistant::onGatewayEvent(const GatewayEvent& event, uint32_t nowMs) {
  switch (event.type) {
    case GatewayEventType::Connected: {
      char hello[384];
      const size_t length = protocol::buildHello(hello, sizeof hello, config::kFirmwareVersion, conversationId_);
      if (length > 0) gateway_.sendText(hello, length);
      break;
    }
    case GatewayEventType::Ready:
      strlcpy(conversationId_, event.conversationId, sizeof conversationId_);
      if (state_ == AssistantState::Offline) enter(AssistantState::Idle, nowMs);
      break;
    case GatewayEventType::Disconnected:
      abortTurn();
      enter(AssistantState::Offline, nowMs);
      break;
    case GatewayEventType::ReplyBegin:
      if (state_ == AssistantState::Thinking && isActiveTurn(event)) {
        replyEnded_ = false;
        audio_.setMode(AudioIo::Mode::Playback);
        enter(AssistantState::Speaking, nowMs);
      }
      break;
    case GatewayEventType::ReplyEnd:
      if (isActiveTurn(event)) replyEnded_ = true;
      break;
    case GatewayEventType::TurnEnd:
      if (isActiveTurn(event) && state_ == AssistantState::Thinking) {
        const bool failed = strcmp(event.detail, "failed") == 0;
        abortTurn();
        enter(failed ? AssistantState::Error : AssistantState::Idle, nowMs);
      } else if (isActiveTurn(event) && state_ == AssistantState::Speaking && strcmp(event.detail, "completed") != 0) {
        replyEnded_ = true;
      }
      break;
    case GatewayEventType::Error:
      if (turnActive_ && (!event.hasTurn || isActiveTurn(event)) && state_ != AssistantState::Listening) {
        abortTurn();
        enter(AssistantState::Error, nowMs);
      }
      break;
  }
}

void Assistant::onButton(ButtonEvent button, uint32_t nowMs) {
  if (button == ButtonEvent::Pressed) {
    if (state_ == AssistantState::Idle) startTurn(nowMs);
    else if (state_ == AssistantState::Thinking || state_ == AssistantState::Speaking) {
      cancelTurn();
      enter(AssistantState::Idle, nowMs);
    }
  } else if (button == ButtonEvent::Released && state_ == AssistantState::Listening) {
    finishListening(nowMs);
  }
}

void Assistant::startTurn(uint32_t nowMs) {
  uint8_t random[protocol::kTurnIdBytes];
  esp_fill_random(random, sizeof random);
  turn_ = protocol::makeTurnId(random);
  char message[320];
  const size_t length = protocol::buildAudioBegin(message, sizeof message, conversationId_, turn_);
  if (length == 0 || !gateway_.sendText(message, length)) {
    enter(AssistantState::Error, nowMs);
    return;
  }
  gateway_.armTurn(turn_);
  turnActive_ = true;
  replyEnded_ = false;
  micBytes_ = 0;
  audio_.setMode(AudioIo::Mode::Capture);
  enter(AssistantState::Listening, nowMs);
}

void Assistant::streamMicrophone() {
  uint8_t chunk[config::kFrameBytes];
  size_t got = 0;
  while ((got = audio_.readCaptured(chunk, sizeof chunk)) > 0) {
    if (gateway_.sendMicrophone(turn_, chunk, got)) micBytes_ += got;
  }
}

void Assistant::finishListening(uint32_t nowMs) {
  audio_.setMode(AudioIo::Mode::Idle);
  streamMicrophone();
  if (millisOfAudio(micBytes_) < config::kMinUtteranceMs) {
    cancelTurn();
    enter(AssistantState::Idle, nowMs);
    return;
  }
  char message[96];
  const size_t length = protocol::buildAudioEnd(message, sizeof message, turn_);
  if (length == 0 || !gateway_.sendText(message, length)) {
    abortTurn();
    enter(AssistantState::Error, nowMs);
    return;
  }
  enter(AssistantState::Thinking, nowMs);
}

void Assistant::cancelTurn() {
  if (turnActive_) {
    char message[128];
    const size_t length = protocol::buildTurnCancel(message, sizeof message, turn_, "user_stop");
    if (length > 0) gateway_.sendText(message, length);
  }
  abortTurn();
}

void Assistant::abortTurn() {
  gateway_.cancelTurn();
  audio_.setMode(AudioIo::Mode::Idle);
  turnActive_ = false;
  replyEnded_ = false;
}

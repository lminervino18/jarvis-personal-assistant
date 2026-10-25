#pragma once

#include <cstddef>
#include <cstdint>

namespace protocol {

constexpr uint8_t kMicAudio = 0x01;
constexpr uint8_t kTtsAudio = 0x02;
constexpr size_t kTurnIdBytes = 16;
constexpr size_t kFrameHeaderBytes = 1 + kTurnIdBytes;
constexpr size_t kUuidTextBytes = 37;
constexpr uint32_t kSampleRate = 16000;

struct TurnId {
  uint8_t bytes[kTurnIdBytes];
};

TurnId makeTurnId(const uint8_t random[kTurnIdBytes]);
bool sameTurn(const TurnId& a, const TurnId& b);
bool parseTurnId(const char* text, TurnId& out);
void formatTurnId(const TurnId& id, char out[kUuidTextBytes]);
void writeMicHeader(const TurnId& id, uint8_t out[kFrameHeaderBytes]);

/** Each builder returns the JSON length, or 0 when it does not fit in `capacity`. */
size_t buildHello(char* out, size_t capacity, const char* version, const char* conversationId);
size_t buildAudioBegin(char* out, size_t capacity, const char* conversationId, const TurnId& turn);
size_t buildAudioEnd(char* out, size_t capacity, const TurnId& turn);
size_t buildTurnCancel(char* out, size_t capacity, const TurnId& turn, const char* reason);
size_t buildPing(char* out, size_t capacity, uint32_t t);

/** Exponential backoff from 1 s up to 60 s, plus up to a quarter of that again as jitter. */
uint32_t reconnectDelayMs(uint32_t attempt, uint32_t randomValue);

/**
 * Decides which binary WebSocket fragments may reach the speaker: only text-to-speech frames of the
 * armed turn, between the server's audio.begin and audio.end, and never after cancel().
 * Not thread safe; the caller serializes access.
 */
class ReplyGate {
 public:
  void arm(const TurnId& turn);
  void beginReply(const TurnId& turn);
  void endReply(const TurnId& turn);
  void cancel();

  /**
   * Feeds one fragment of a binary message (`offset` is the fragment's position inside the message).
   * Copies whole 16-bit samples to `out`, which must hold `size + 1` bytes, and returns how many bytes.
   */
  size_t filter(const uint8_t* fragment, size_t size, size_t offset, uint8_t* out);

  uint32_t dropped() const { return dropped_; }

 private:
  TurnId turn_{};
  bool armed_ = false;
  bool receiving_ = false;
  bool accepting_ = false;
  bool hasCarry_ = false;
  uint8_t carry_ = 0;
  uint32_t dropped_ = 0;
};

}  // namespace protocol

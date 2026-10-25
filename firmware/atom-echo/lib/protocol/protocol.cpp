#include "protocol.h"

#include <cstdio>
#include <cstring>

namespace protocol {

namespace {

const char kFormat[] = "{\"encoding\":\"pcm_s16le\",\"sampleRate\":16000,\"channels\":1}";

size_t finish(int written, size_t capacity) {
  return written > 0 && static_cast<size_t>(written) < capacity ? static_cast<size_t>(written) : 0;
}

}  // namespace

TurnId makeTurnId(const uint8_t random[kTurnIdBytes]) {
  TurnId id;
  std::memcpy(id.bytes, random, kTurnIdBytes);
  id.bytes[6] = (id.bytes[6] & 0x0F) | 0x40;
  id.bytes[8] = (id.bytes[8] & 0x3F) | 0x80;
  return id;
}

bool sameTurn(const TurnId& a, const TurnId& b) {
  return std::memcmp(a.bytes, b.bytes, kTurnIdBytes) == 0;
}

bool parseTurnId(const char* text, TurnId& out) {
  size_t byte = 0;
  for (size_t i = 0; text[i] != '\0'; i++) {
    if (text[i] == '-') {
      if (i != 8 && i != 13 && i != 18 && i != 23) return false;
      continue;
    }
    if (byte >= kTurnIdBytes * 2 || i + 1 >= kUuidTextBytes) return false;
    const char c = text[i];
    int nibble = 0;
    if (c >= '0' && c <= '9') nibble = c - '0';
    else if (c >= 'a' && c <= 'f') nibble = c - 'a' + 10;
    else if (c >= 'A' && c <= 'F') nibble = c - 'A' + 10;
    else return false;
    if (byte % 2 == 0) out.bytes[byte / 2] = static_cast<uint8_t>(nibble << 4);
    else out.bytes[byte / 2] |= static_cast<uint8_t>(nibble);
    byte++;
  }
  return byte == kTurnIdBytes * 2;
}

uint32_t reconnectDelayMs(uint32_t attempt, uint32_t randomValue) {
  const uint32_t base = attempt >= 6 ? 60000 : 1000u << attempt;
  const uint32_t capped = base > 60000 ? 60000 : base;
  return capped + randomValue % (capped / 4 + 1);
}

void formatTurnId(const TurnId& id, char out[kUuidTextBytes]) {
  std::snprintf(out, kUuidTextBytes, "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x", id.bytes[0], id.bytes[1],
                id.bytes[2], id.bytes[3], id.bytes[4], id.bytes[5], id.bytes[6], id.bytes[7], id.bytes[8], id.bytes[9], id.bytes[10],
                id.bytes[11], id.bytes[12], id.bytes[13], id.bytes[14], id.bytes[15]);
}

void writeMicHeader(const TurnId& id, uint8_t out[kFrameHeaderBytes]) {
  out[0] = kMicAudio;
  std::memcpy(out + 1, id.bytes, kTurnIdBytes);
}

size_t buildHello(char* out, size_t capacity, const char* version, const char* conversationId) {
  char resume[64] = "";
  if (conversationId && conversationId[0]) std::snprintf(resume, sizeof resume, ",\"conversationId\":\"%s\"", conversationId);
  const int written = std::snprintf(out, capacity,
                                    "{\"type\":\"hello\",\"protocol\":1,\"client\":{\"kind\":\"device\",\"version\":\"%s\"},"
                                    "\"audio\":{\"input\":[%s],\"output\":[%s]},\"history\":false%s}",
                                    version, kFormat, kFormat, resume);
  return finish(written, capacity);
}

size_t buildAudioBegin(char* out, size_t capacity, const char* conversationId, const TurnId& turn) {
  char id[kUuidTextBytes];
  formatTurnId(turn, id);
  const int written = std::snprintf(out, capacity,
                                    "{\"type\":\"audio.begin\",\"conversationId\":\"%s\",\"turnId\":\"%s\",\"format\":%s,\"replyMode\":\"voice\"}",
                                    conversationId, id, kFormat);
  return finish(written, capacity);
}

size_t buildAudioEnd(char* out, size_t capacity, const TurnId& turn) {
  char id[kUuidTextBytes];
  formatTurnId(turn, id);
  return finish(std::snprintf(out, capacity, "{\"type\":\"audio.end\",\"turnId\":\"%s\"}", id), capacity);
}

size_t buildTurnCancel(char* out, size_t capacity, const TurnId& turn, const char* reason) {
  char id[kUuidTextBytes];
  formatTurnId(turn, id);
  return finish(std::snprintf(out, capacity, "{\"type\":\"turn.cancel\",\"turnId\":\"%s\",\"reason\":\"%s\"}", id, reason), capacity);
}

size_t buildPing(char* out, size_t capacity, uint32_t t) {
  return finish(std::snprintf(out, capacity, "{\"type\":\"ping\",\"t\":%lu}", static_cast<unsigned long>(t)), capacity);
}

void ReplyGate::arm(const TurnId& turn) {
  turn_ = turn;
  armed_ = true;
  receiving_ = false;
  accepting_ = false;
  hasCarry_ = false;
}

void ReplyGate::beginReply(const TurnId& turn) {
  receiving_ = armed_ && sameTurn(turn, turn_);
}

void ReplyGate::endReply(const TurnId& turn) {
  if (!sameTurn(turn, turn_)) return;
  receiving_ = false;
  accepting_ = false;
}

void ReplyGate::cancel() {
  armed_ = false;
  receiving_ = false;
  accepting_ = false;
  hasCarry_ = false;
}

size_t ReplyGate::filter(const uint8_t* fragment, size_t size, size_t offset, uint8_t* out) {
  size_t skip = 0;
  if (offset == 0) {
    hasCarry_ = false;
    accepting_ = false;
    if (size >= kFrameHeaderBytes && fragment[0] == kTtsAudio && armed_ && receiving_) {
      TurnId frameTurn;
      std::memcpy(frameTurn.bytes, fragment + 1, kTurnIdBytes);
      accepting_ = sameTurn(frameTurn, turn_);
    }
    skip = kFrameHeaderBytes;
  }
  if (!accepting_) {
    if (offset == 0) ++dropped_;
    return 0;
  }
  size_t written = 0;
  if (hasCarry_ && size > skip) {
    out[written++] = carry_;
    hasCarry_ = false;
  }
  if (size <= skip) return written;
  const size_t payload = size - skip;
  const size_t usable = (written + payload) & ~static_cast<size_t>(1);
  const size_t copy = usable - written;
  std::memcpy(out + written, fragment + skip, copy);
  if (copy < payload) {
    carry_ = fragment[skip + copy];
    hasCarry_ = true;
  }
  return usable;
}

}  // namespace protocol

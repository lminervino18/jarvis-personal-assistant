#include <cassert>
#include <cstdio>
#include <cstring>
#include <vector>

#include "protocol.h"

using namespace protocol;

namespace {

TurnId turnFrom(uint8_t seed) {
  uint8_t random[kTurnIdBytes];
  for (size_t i = 0; i < kTurnIdBytes; i++) random[i] = static_cast<uint8_t>(seed + i);
  return makeTurnId(random);
}

std::vector<uint8_t> ttsMessage(const TurnId& turn, const std::vector<uint8_t>& pcm) {
  std::vector<uint8_t> message{kTtsAudio};
  message.insert(message.end(), turn.bytes, turn.bytes + kTurnIdBytes);
  message.insert(message.end(), pcm.begin(), pcm.end());
  return message;
}

std::vector<uint8_t> feedInFragments(ReplyGate& gate, const std::vector<uint8_t>& message, size_t fragmentSize) {
  std::vector<uint8_t> played;
  std::vector<uint8_t> out(fragmentSize + 1);
  for (size_t offset = 0; offset < message.size(); offset += fragmentSize) {
    const size_t size = std::min(fragmentSize, message.size() - offset);
    const size_t n = gate.filter(message.data() + offset, size, offset, out.data());
    played.insert(played.end(), out.begin(), out.begin() + n);
  }
  return played;
}

std::vector<uint8_t> ramp(size_t bytes) {
  std::vector<uint8_t> pcm(bytes);
  for (size_t i = 0; i < bytes; i++) pcm[i] = static_cast<uint8_t>(i);
  return pcm;
}

void turnIdsAreVersion4Uuids() {
  char text[kUuidTextBytes];
  formatTurnId(turnFrom(0), text);
  assert(std::strlen(text) == 36);
  assert(text[14] == '4');
  assert(std::strchr("89ab", text[19]) != nullptr);
  assert(std::strcmp(text, "00010203-0405-4607-8809-0a0b0c0d0e0f") == 0);
}

void turnIdsRoundTripThroughText() {
  TurnId parsed;
  const TurnId original = turnFrom(9);
  char text[kUuidTextBytes];
  formatTurnId(original, text);
  assert(parseTurnId(text, parsed) && sameTurn(parsed, original));
  assert(!parseTurnId("not-a-uuid", parsed));
  assert(!parseTurnId("00010203-0405-4607-8809-0a0b0c0d0e0g", parsed));
  assert(!parseTurnId("00010203-0405-4607-8809-0a0b0c0d0e0f0", parsed));
  assert(!parseTurnId("", parsed));
}

void reconnectDelayGrowsAndIsCapped() {
  assert(reconnectDelayMs(0, 0) == 1000);
  assert(reconnectDelayMs(1, 0) == 2000);
  assert(reconnectDelayMs(5, 0) == 32000);
  assert(reconnectDelayMs(6, 0) == 60000);
  assert(reconnectDelayMs(1000, 0) == 60000);
  assert(reconnectDelayMs(0, 123456789) < 1000 + 251);
  assert(reconnectDelayMs(10, 123456789) <= 60000 + 15000);
}

void gateKeepsReceivingWhenAnotherTurnEnds() {
  ReplyGate gate;
  const TurnId mine = turnFrom(1);
  const auto pcm = ramp(64);
  gate.arm(mine);
  gate.beginReply(mine);
  gate.endReply(turnFrom(2));
  assert(feedInFragments(gate, ttsMessage(mine, pcm), 1000) == pcm);
}

void gateIgnoresAReplyBeginForAnotherTurn() {
  ReplyGate gate;
  const TurnId mine = turnFrom(1);
  gate.arm(mine);
  gate.beginReply(turnFrom(2));
  assert(feedInFragments(gate, ttsMessage(mine, ramp(64)), 1000).empty());
}

void micHeaderCarriesKindAndTurn() {
  uint8_t header[kFrameHeaderBytes];
  const TurnId turn = turnFrom(7);
  writeMicHeader(turn, header);
  assert(header[0] == kMicAudio);
  assert(std::memcmp(header + 1, turn.bytes, kTurnIdBytes) == 0);
}

void buildersMatchTheServerSchema() {
  char json[512];
  const TurnId turn = turnFrom(0);
  assert(buildHello(json, sizeof json, "0.1.0", nullptr) > 0);
  assert(std::strstr(json, "\"kind\":\"device\"") && !std::strstr(json, "conversationId"));
  assert(buildHello(json, sizeof json, "0.1.0", "abc") > 0 && std::strstr(json, "\"conversationId\":\"abc\"}"));
  assert(buildAudioBegin(json, sizeof json, "conv", turn) > 0);
  assert(std::strstr(json, "\"turnId\":\"00010203-0405-4607-8809-0a0b0c0d0e0f\"") && std::strstr(json, "\"replyMode\":\"voice\""));
  assert(buildAudioEnd(json, sizeof json, turn) > 0 && std::strstr(json, "\"type\":\"audio.end\""));
  assert(buildTurnCancel(json, sizeof json, turn, "user_stop") > 0 && std::strstr(json, "\"reason\":\"user_stop\""));
  assert(buildPing(json, sizeof json, 42) > 0 && std::strcmp(json, "{\"type\":\"ping\",\"t\":42}") == 0);
}

void buildersReportTruncation() {
  char tiny[16];
  assert(buildHello(tiny, sizeof tiny, "0.1.0", nullptr) == 0);
  assert(buildAudioEnd(tiny, sizeof tiny, turnFrom(0)) == 0);
}

void gateAcceptsOnlyTheArmedTurnWhileReceiving() {
  ReplyGate gate;
  const TurnId mine = turnFrom(1);
  const auto pcm = ramp(640);
  gate.arm(mine);
  assert(feedInFragments(gate, ttsMessage(mine, pcm), 1000).empty());
  gate.beginReply(mine);
  assert(feedInFragments(gate, ttsMessage(mine, pcm), 1000) == pcm);
  assert(feedInFragments(gate, ttsMessage(turnFrom(2), pcm), 1000).empty());
  gate.endReply(mine);
  assert(feedInFragments(gate, ttsMessage(mine, pcm), 1000).empty());
  assert(gate.dropped() == 3);
}

void gateDropsEverythingAfterCancel() {
  ReplyGate gate;
  const TurnId mine = turnFrom(1);
  gate.arm(mine);
  gate.beginReply(mine);
  gate.cancel();
  assert(feedInFragments(gate, ttsMessage(mine, ramp(640)), 1000).empty());
}

void gateStopsInTheMiddleOfAMessageWhenCancelled() {
  ReplyGate gate;
  const TurnId mine = turnFrom(1);
  const auto message = ttsMessage(mine, ramp(3000));
  uint8_t out[1025];
  gate.arm(mine);
  gate.beginReply(mine);
  assert(gate.filter(message.data(), 1024, 0, out) > 0);
  gate.cancel();
  assert(gate.filter(message.data() + 1024, 1024, 1024, out) == 0);
}

void gateRealignsSamplesAcrossFragments() {
  const TurnId mine = turnFrom(1);
  const auto pcm = ramp(3200);
  for (size_t fragmentSize : {17, 18, 19, 100, 1024, 1025}) {
    ReplyGate gate;
    gate.arm(mine);
    gate.beginReply(mine);
    assert(feedInFragments(gate, ttsMessage(mine, pcm), fragmentSize) == pcm);
  }
}

void gateIgnoresMicFramesAndShortMessages() {
  ReplyGate gate;
  const TurnId mine = turnFrom(1);
  gate.arm(mine);
  gate.beginReply(mine);
  auto mic = ttsMessage(mine, ramp(64));
  mic[0] = kMicAudio;
  assert(feedInFragments(gate, mic, 1000).empty());
  assert(feedInFragments(gate, std::vector<uint8_t>{kTtsAudio, 1, 2}, 1000).empty());
}

}  // namespace

int main() {
  turnIdsAreVersion4Uuids();
  turnIdsRoundTripThroughText();
  reconnectDelayGrowsAndIsCapped();
  gateIgnoresAReplyBeginForAnotherTurn();
  gateKeepsReceivingWhenAnotherTurnEnds();
  micHeaderCarriesKindAndTurn();
  buildersMatchTheServerSchema();
  buildersReportTruncation();
  gateAcceptsOnlyTheArmedTurnWhileReceiving();
  gateDropsEverythingAfterCancel();
  gateStopsInTheMiddleOfAMessageWhenCancelled();
  gateRealignsSamplesAcrossFragments();
  gateIgnoresMicFramesAndShortMessages();
  std::puts("protocol tests passed");
  return 0;
}

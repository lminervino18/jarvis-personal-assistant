#include "console.h"

#include <Arduino.h>

namespace {

const char kHelp[] =
    "commands: wifi <ssid> <password> | server <host> <port> <path> | token <token> | show | stats | reboot | clear";

template <size_t N>
bool copyInto(char (&target)[N], const char* value) {
  if (!value || strlen(value) >= N) return false;
  strcpy(target, value);
  return true;
}

}  // namespace

void Console::poll() {
  while (Serial.available() > 0) {
    const char c = static_cast<char>(Serial.read());
    if (c == '\r' || c == '\n') {
      line_[length_] = '\0';
      if (length_ > 0) handle(line_);
      length_ = 0;
    } else if (length_ + 1 < sizeof line_) {
      line_[length_++] = c;
    }
  }
}

void Console::handle(char* line) {
  char* save = nullptr;
  const char* command = strtok_r(line, " ", &save);
  if (!command) return;
  if (strcmp(command, "wifi") == 0) {
    const char* ssid = strtok_r(nullptr, " ", &save);
    const char* password = save && *save ? save : "";
    if (!copyInto(settings_.ssid, ssid) || !copyInto(settings_.password, password)) return void(Serial.println("invalid wifi arguments"));
    settings_.save();
    Serial.println("saved, run reboot to apply");
  } else if (strcmp(command, "server") == 0) {
    const char* host = strtok_r(nullptr, " ", &save);
    const char* port = strtok_r(nullptr, " ", &save);
    const char* path = strtok_r(nullptr, " ", &save);
    const long portNumber = port ? atol(port) : 0;
    if (portNumber < 1 || portNumber > 65535 || !path || path[0] != '/') return void(Serial.println("usage: server <host> <port> </path>"));
    if (!copyInto(settings_.host, host) || !copyInto(settings_.path, path)) return void(Serial.println("invalid server arguments"));
    settings_.port = static_cast<uint16_t>(portNumber);
    settings_.save();
    Serial.println("saved, run reboot to apply");
  } else if (strcmp(command, "token") == 0) {
    if (!copyInto(settings_.token, strtok_r(nullptr, " ", &save))) return void(Serial.println("invalid token"));
    settings_.save();
    Serial.println("saved, run reboot to apply");
  } else if (strcmp(command, "show") == 0) {
    show();
  } else if (strcmp(command, "stats") == 0) {
    printStats_();
  } else if (strcmp(command, "reboot") == 0) {
    ESP.restart();
  } else if (strcmp(command, "clear") == 0) {
    settings_.clear();
    Serial.println("settings erased, run reboot");
  } else {
    Serial.println(kHelp);
  }
}

void Console::show() const {
  Serial.printf("ssid=%s password=%s\n", settings_.ssid, settings_.password[0] ? "(set)" : "(empty)");
  Serial.printf("server=%s:%u%s token=%s\n", settings_.host, settings_.port, settings_.path, settings_.token[0] ? "(set)" : "(empty)");
}

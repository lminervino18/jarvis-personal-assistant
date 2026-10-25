#pragma once

#include <cstddef>
#include <cstdint>

struct Settings {
  char ssid[33] = "";
  char password[65] = "";
  char host[64] = "";
  uint16_t port = 443;
  char path[48] = "/ws/device";
  char token[64] = "";

  bool complete() const { return ssid[0] && host[0] && token[0]; }
  void load();
  void save() const;
  void clear();
};

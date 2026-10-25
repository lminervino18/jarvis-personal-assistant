#pragma once

#include <functional>

#include "settings.h"

/** Line-based USB serial console used for provisioning and diagnostics. */
class Console {
 public:
  Console(Settings& settings, std::function<void()> printStats) : settings_(settings), printStats_(std::move(printStats)) {}
  void poll();

 private:
  void handle(char* line);
  void show() const;

  Settings& settings_;
  std::function<void()> printStats_;
  char line_[160] = "";
  size_t length_ = 0;
};

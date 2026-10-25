#include "settings.h"

#include <Preferences.h>

namespace {

const char kNamespace[] = "jarvis";

}  // namespace

void Settings::load() {
  Preferences prefs;
  prefs.begin(kNamespace, true);
  prefs.getString("ssid", ssid, sizeof ssid);
  prefs.getString("password", password, sizeof password);
  prefs.getString("host", host, sizeof host);
  port = prefs.getUShort("port", 443);
  if (prefs.isKey("path")) prefs.getString("path", path, sizeof path);
  prefs.getString("token", token, sizeof token);
  prefs.end();
}

void Settings::save() const {
  Preferences prefs;
  prefs.begin(kNamespace, false);
  prefs.putString("ssid", ssid);
  prefs.putString("password", password);
  prefs.putString("host", host);
  prefs.putUShort("port", port);
  prefs.putString("path", path);
  prefs.putString("token", token);
  prefs.end();
}

void Settings::clear() {
  Preferences prefs;
  prefs.begin(kNamespace, false);
  prefs.clear();
  prefs.end();
  *this = Settings();
}

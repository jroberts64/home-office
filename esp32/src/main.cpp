// Basement Office PIN gadget.
// Shows the current rotating 6-digit TOTP on an SSD1306 OLED, with a countdown
// bar to the next rotation. Same shared secret as the Lambda that validates it.

#include <Arduino.h>
#include <WiFi.h>
#include <time.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <TOTP.h>

#include "secrets.h"

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_ADDR 0x3C
#define TOTP_PERIOD 30  // seconds; must match pyotp's default

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);

// --- Base32 decode (the library wants raw key bytes, not base32) -----------
static uint8_t hmacKey[64];
static int hmacKeyLen = 0;

static int base32Decode(const char *in, uint8_t *out, int outCap) {
  int buffer = 0, bitsLeft = 0, count = 0;
  for (const char *p = in; *p && count < outCap; p++) {
    char c = *p;
    if (c == '=' || c == ' ' || c == '-') continue;
    int val;
    if (c >= 'A' && c <= 'Z') val = c - 'A';
    else if (c >= 'a' && c <= 'z') val = c - 'a';
    else if (c >= '2' && c <= '7') val = c - '2' + 26;
    else continue;  // skip anything non-base32
    buffer = (buffer << 5) | val;
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      out[count++] = (uint8_t)(buffer >> (bitsLeft - 8));
      bitsLeft -= 8;
    }
  }
  return count;
}

TOTP *totp = nullptr;

void connectWiFi() {
  display.clearDisplay();
  display.setCursor(0, 0);
  display.println("Connecting WiFi...");
  display.display();

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
  }
}

void syncTime() {
  // TOTP is time-based — get accurate UTC from NTP.
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  display.clearDisplay();
  display.setCursor(0, 0);
  display.println("Syncing clock...");
  display.display();

  struct tm tm;
  while (!getLocalTime(&tm)) {
    delay(300);
  }
}

void setup() {
  Serial.begin(115200);
  Wire.begin();
  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    Serial.println("SSD1306 not found");
    for (;;) delay(1000);
  }
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);

  hmacKeyLen = base32Decode(TOTP_BASE32_SECRET, hmacKey, sizeof(hmacKey));
  totp = new TOTP(hmacKey, hmacKeyLen, TOTP_PERIOD);

  connectWiFi();
  syncTime();
}

void loop() {
  time_t now = time(nullptr);
  char *code = totp->getCode(now);
  int remaining = TOTP_PERIOD - (now % TOTP_PERIOD);

  display.clearDisplay();

  // Heading
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println("Basement Office PIN");

  // Big PIN
  display.setTextSize(3);
  display.setCursor(8, 22);
  display.println(code);

  // Countdown bar
  int barWidth = (int)((float)remaining / TOTP_PERIOD * SCREEN_WIDTH);
  display.fillRect(0, 58, barWidth, 6, SSD1306_WHITE);

  display.display();
  delay(1000);
}

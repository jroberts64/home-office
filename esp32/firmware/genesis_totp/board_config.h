// board_config.h — per-board pins/driver/layout for genesis_totp.
//
// Select the target board below (or override at build time with
//   arduino-cli compile --build-property "compiler.cpp.extra_flags=-DTARGET_BOARD=2" ...
// ). All board-specific wiring lives here; the sketch itself is board-neutral.

#pragma once

#define BOARD_GENESIS_MINI 1
#define BOARD_CYD          2

#ifndef TARGET_BOARD
#define TARGET_BOARD BOARD_GENESIS_MINI   // <-- change to BOARD_CYD for the CYD
#endif

// ===========================================================================
#if TARGET_BOARD == BOARD_GENESIS_MINI
// Axiometa Genesis Mini (ESP32-S3) + IPS ST7735S 160x80 on AX22 Port 1.
// FQBN: esp32:esp32:axiometa_genesis_mini
// ===========================================================================
  #define BOARD_NAME       "Genesis Mini"
  #define USE_ST7735       1
  #define DISPLAY_BGR      1        // this panel is BGR-ordered
  #define TFT_W_LANDSCAPE  160
  #define TFT_H_LANDSCAPE  80
  #define TFT_ROTATION     3

  // Display SPI (FSPI). SPI bus is shared across AX22 ports; CS/DC/RST are the
  // plugged-in port's GPIOs — these are Port 1 (found via the pin-hunt).
  #define TFT_SCLK  14
  #define TFT_MOSI  12
  #define TFT_MISO  -1
  #define TFT_CS    4
  #define TFT_DC    2
  #define TFT_RST   3
  #define TFT_BL    -1             // module backlight is transistor-driven (always on)

  #define BTN_PIN   45             // USER button, active-low

  #define RGB_NEOPIXEL 1           // single addressable LED
  #define RGB_PIN   21

  // Layout
  #define HEADER_TEXTSIZE 1
  #define CODE_TEXTSIZE   4
  #define BAR_THICK       12

// ===========================================================================
#elif TARGET_BOARD == BOARD_CYD
// ESP32-2432S028R "Cheap Yellow Display" (ESP32-WROOM) + ILI9341 240x320.
// FQBN: esp32:esp32:esp32   (ESP32 Dev Module; PSRAM disabled, default partition)
// ===========================================================================
  #define BOARD_NAME       "CYD 2432S028R"
  #define USE_ILI9341      1
  #define DISPLAY_BGR      0        // ILI9341 handles BGR internally; flip to 1 if R/B look swapped
  #define TFT_W_LANDSCAPE  320
  #define TFT_H_LANDSCAPE  240
  #define TFT_ROTATION     1

  // Display on HSPI (documented ESP32-2432S028R wiring).
  #define TFT_SCLK  14
  #define TFT_MOSI  13
  #define TFT_MISO  12
  #define TFT_CS    15
  #define TFT_DC    2
  #define TFT_RST   -1             // tied to the board reset line
  #define TFT_BL    21             // backlight enable, active-high (MUST drive HIGH)

  #define BTN_PIN   0              // BOOT button, active-low

  #define RGB_3PIN  1              // discrete common-anode RGB LED, active-LOW
  #define RGB_R     4
  #define RGB_G     16
  #define RGB_B     17

  // Layout (much larger screen)
  #define HEADER_TEXTSIZE 2
  #define CODE_TEXTSIZE   7
  #define BAR_THICK       24

  // Unused here but present on the board (for future features):
  //   Resistive touch XPT2046 (HSPI-ish): CLK=25 CS=33 MOSI=32 MISO=39 IRQ=36
  //   microSD: CS=5 (VSPI: MOSI=23 MISO=19 SCK=18) ; LDR light sensor: GPIO34

// ===========================================================================
#else
  #error "TARGET_BOARD must be BOARD_GENESIS_MINI or BOARD_CYD"
#endif

// Landscape dimensions used by the sketch.
static const int16_t TFT_W = TFT_W_LANDSCAPE;
static const int16_t TFT_H = TFT_H_LANDSCAPE;

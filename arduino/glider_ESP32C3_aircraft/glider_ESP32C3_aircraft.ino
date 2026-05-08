// =============================================================
//  glider_ESP32C3_aircraft.ino
//  自律滑空機・機体側 ESP32-C3 用ブリッジ
//  対象: Seeed XIAO ESP32-C3 (#2, MAC=94:A9:90:6D:52:50)
//
//  役割: nRF52840 (Serial1) <--> ESP-NOW
//
//  配線:
//    nRF52840 D6 (TX) -- D7 (RX) ESP32-C3
//    nRF52840 D7 (RX) -- D6 (TX) ESP32-C3
//    nRF52840 GND     -- GND     ESP32-C3
//
//  注意: peerMac は「相手機（地上側）」の MAC を指定
// =============================================================

#include <Arduino.h>
#include "espnow_uart_bridge.h"

#define LED_PIN     2
#define UART_BAUD   115200
#define UART_PORT   Serial1   // nRF52840 と Serial1 で接続

// XIAO ESP32-C3 のピン定義（D6/D7 を Serial1 に割当）
#define D7 20
#define D6 21
#define UART_RX_PIN D7
#define UART_TX_PIN D6

// 地上側 #1 ESP32-C3 の MAC を指定
const uint8_t peerMac[6] = {0x58, 0x8C, 0x81, 0xAE, 0xE0, 0x60};

void setup() {
  espnow_uart_bridge::configure(peerMac, UART_PORT, LED_PIN);

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  // ローカルデバッグ用に USB Serial も開く
  Serial.begin(115200);
  Serial.println("[READY] aircraft ESP32-C3 bridge: Serial1(D6/D7) <-> ESP-NOW");

  // nRF52840 と Serial1 接続
  UART_PORT.begin(UART_BAUD, SERIAL_8N1, UART_RX_PIN, UART_TX_PIN);
  delay(200);

  espnow_uart_bridge::initializeEspNow();
}

void loop() {
  espnow_uart_bridge::processUartLoop();
  delay(1);
}

// =============================================================
//  glider_ESP32C3_ground.ino
//  自律滑空機・地上側 ESP32-C3 用ブリッジ
//  対象: Seeed XIAO ESP32-C3 (#1, MAC=58:8C:81:AE:E0:60)
//
//  役割: PC USB Serial <--> ESP-NOW
//
//  PC -> 機体: シリアルモニタの入力 -> ESP-NOW -> 機体側 ESP32 -> nRF52840
//  機体 -> PC: nRF52840 -> Serial1 -> 機体側 ESP32 -> ESP-NOW -> ここ -> PC
//
//  注意: peerMac は「相手機（機体側）」の MAC を指定
// =============================================================

#include <Arduino.h>
#include "espnow_uart_bridge.h"

#define LED_PIN     2
#define UART_BAUD   115200
#define UART_PORT   Serial   // PC との通信は USB Serial

// 機体側 #2 ESP32-C3 の MAC を指定
const uint8_t peerMac[6] = {0x94, 0xA9, 0x90, 0x6D, 0x52, 0x50};

void setup() {
  espnow_uart_bridge::configure(peerMac, UART_PORT, LED_PIN);

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  UART_PORT.begin(UART_BAUD);
  delay(200);

  espnow_uart_bridge::initializeEspNow();
  UART_PORT.println("[READY] ground ESP32-C3 bridge: USB <-> ESP-NOW");
  UART_PORT.println("[INFO]  /mac /stat /help for local commands.");
}

void loop() {
  espnow_uart_bridge::processUartLoop();
  delay(1);
}

// =============================================================
//  glider_ESP32C3_ground.ino
//  自律滑空機・地上側 ESP32-C3 用ブリッジ
//  対象: Seeed XIAO ESP32-C3 (地上側)
//
//  役割: PC USB Serial <--> ESP-NOW (暗号化)
//
//  PC -> 機体: シリアルモニタの入力 -> ESP-NOW -> 機体側 ESP32 -> nRF52840
//  機体 -> PC: nRF52840 -> Serial1 -> 機体側 ESP32 -> ESP-NOW -> ここ -> PC
//
//  ペアリング:
//    DEFAULT_PEER_MAC は工場出荷時のフォールバック。
//    実機運用では USB シリアルから /setpeer XX:XX:XX:XX:XX:XX を打って NVS に保存する。
// =============================================================

#include <Arduino.h>
#include "esp_task_wdt.h"
#include "espnow_uart_bridge.h"

#define LED_PIN     2
#define UART_BAUD   115200
#define UART_PORT   Serial   // PC との通信は USB Serial

#define WDT_TIMEOUT_S 5

const uint8_t DEFAULT_PEER_MAC[6] = {0x00, 0x00, 0x00, 0x00, 0x00, 0x00};

// esp32 core 2.x / 3.x の API 差異を吸収して loop タスクを WDT 監視対象に
static void setupTaskWdt(uint32_t timeout_s) {
#if defined(ESP_ARDUINO_VERSION) && ESP_ARDUINO_VERSION >= ESP_ARDUINO_VERSION_VAL(3, 0, 0)
  // 3.x: 既定で IDLE タスクに WDT が掛かっているので、いったん解除してから再設定
  esp_task_wdt_deinit();
  esp_task_wdt_config_t cfg = {};
  cfg.timeout_ms = timeout_s * 1000U;
  cfg.idle_core_mask = 0;
  cfg.trigger_panic = true;
  esp_task_wdt_init(&cfg);
#else
  esp_task_wdt_init(timeout_s, true);
#endif
  esp_task_wdt_add(NULL);
}

void setup() {
  // 1) USB CDC を最優先で開ける（ground 側は UART_PORT == Serial）
  UART_PORT.begin(UART_BAUD);
  unsigned long t0 = millis();
  while (!UART_PORT && (millis() - t0) < 3000) {
    delay(50);
  }
  delay(300);
  UART_PORT.println();
  UART_PORT.println("=============================");
  UART_PORT.println("[BOOT 1] ground ESP32-C3 starting...");
  UART_PORT.println("=============================");
  UART_PORT.flush();

  // 2) WDT 設定
  setupTaskWdt(WDT_TIMEOUT_S);
  esp_task_wdt_reset();
  UART_PORT.println("[BOOT 2] wdt configured");
  UART_PORT.flush();

  // 3) ブリッジ設定 (NVS 読み込み)
  espnow_uart_bridge::configure(DEFAULT_PEER_MAC, UART_PORT, LED_PIN, "espnow_gnd");
  esp_task_wdt_reset();
  UART_PORT.println("[BOOT 3] bridge configured (NVS loaded)");
  UART_PORT.flush();

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  // 4) ESP-NOW 初期化
  espnow_uart_bridge::initializeEspNow();
  esp_task_wdt_reset();
  UART_PORT.println("[READY] ground ESP32-C3 bridge: USB <-> ESP-NOW (encrypted)");
  UART_PORT.println("[INFO]  /mac /stat /help /setpeer /unpair /channel for local commands.");
  UART_PORT.flush();

  espnow_uart_bridge::printMacAddresses();
}

void loop() {
  esp_task_wdt_reset();
  espnow_uart_bridge::processUartLoop();
  delay(1);
}

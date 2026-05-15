// =============================================================
//  glider_ESP32C3_aircraft.ino
//  自律滑空機・機体側 ESP32-C3 用ブリッジ
//  対象: Seeed XIAO ESP32-C3 (機体側)
//
//  役割: nRF52840 (Serial1) <--> ESP-NOW (暗号化)
//
//  配線:
//    nRF52840 D6 (TX) -- D7 (RX) ESP32-C3
//    nRF52840 D7 (RX) -- D6 (TX) ESP32-C3
//    nRF52840 GND     -- GND     ESP32-C3
//
//  ペアリング:
//    DEFAULT_PEER_MAC は工場出荷時のフォールバック。
//    実機運用では地上側のシリアルから /setpeer XX:XX:XX:XX:XX:XX を打って NVS に保存する。
//    （NVS に値があればそれが優先される）
// =============================================================

#include <Arduino.h>
#include "esp_task_wdt.h"
#include "espnow_uart_bridge.h"

#define LED_PIN     2
#define UART_BAUD   115200
#define UART_PORT   Serial1   // nRF52840 と Serial1 で接続

// XIAO ESP32-C3 のピン定義（D6/D7 を Serial1 に割当）
#define D7 20
#define D6 21
#define UART_RX_PIN D7
#define UART_TX_PIN D6

// WDT タイムアウト（秒）。loop() がこの時間ブロックすると自動リブート。
// 起動時の WiFi 初期化が長引く可能性があるので余裕を持たせる
#define WDT_TIMEOUT_S 5

// 工場出荷時の既定 peer MAC（NVS に保存値が無いときの fallback）。
// 実運用では /setpeer で上書きする想定。
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
  // 1) USB CDC を最優先で開けて、以降の進捗を [BOOT N] で USB に流す
  Serial.begin(115200);
  // USB CDC のホスト接続を最大 3 秒待つ（接続が無い場合はタイムアウトで先に進む）
  unsigned long t0 = millis();
  while (!Serial && (millis() - t0) < 3000) {
    delay(50);
  }
  delay(300);
  Serial.println();
  Serial.println("=============================");
  Serial.println("[BOOT 1] aircraft ESP32-C3 starting...");
  Serial.println("=============================");
  Serial.flush();

  // 2) WDT を loop タスクに対して有効化
  setupTaskWdt(WDT_TIMEOUT_S);
  esp_task_wdt_reset();
  Serial.println("[BOOT 2] wdt configured");
  Serial.flush();

  // 3) ブリッジ設定（NVS 読み込み）
  espnow_uart_bridge::configure(DEFAULT_PEER_MAC, UART_PORT, LED_PIN, "espnow_air");
  esp_task_wdt_reset();
  Serial.println("[BOOT 3] bridge configured (NVS loaded)");
  Serial.flush();

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  // 4) Serial1 (nRF52840 と接続)
  UART_PORT.begin(UART_BAUD, SERIAL_8N1, UART_RX_PIN, UART_TX_PIN);
  delay(200);
  esp_task_wdt_reset();
  Serial.println("[BOOT 4] uart1 ready");
  Serial.flush();

  // 5) ESP-NOW 初期化（panicしない、エラーは USB に出る）
  espnow_uart_bridge::initializeEspNow();
  esp_task_wdt_reset();
  Serial.println("[READY] aircraft ESP32-C3 bridge: Serial1(D6/D7) <-> ESP-NOW (encrypted)");
  Serial.println("[INFO]  USB local commands: /mac /stat /help /setpeer XX:.. /unpair /channel <n>");
  Serial.flush();

  // 6) 起動時に MAC を表示
  espnow_uart_bridge::handleLocalCommandOn(Serial, "/mac");
}

void loop() {
  esp_task_wdt_reset();
  espnow_uart_bridge::processUartLoop();
  // USB シリアルからの local コマンド (/setpeer など) を受け付ける
  espnow_uart_bridge::pollLocalCommands(Serial);
  delay(1);
}

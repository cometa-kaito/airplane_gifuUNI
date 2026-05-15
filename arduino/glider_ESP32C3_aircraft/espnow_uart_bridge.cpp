#include "espnow_uart_bridge.h"

#include <WiFi.h>
#include <esp_wifi.h>
#include <Preferences.h>
#include <string.h>
#include <ctype.h>
#include <stdio.h>

#include "uart_line_protocol.h"
#include "secrets.h"

namespace espnow_uart_bridge {

using namespace uart_line_bridge;

static constexpr int kDefaultChannel = 1;
static constexpr uint16_t kLineMax = 220;

static uint32_t g_tx_seq = 0;
static uint32_t g_bad_frames = 0;
static uint32_t g_sent_lines = 0;
static uint32_t g_recv_lines = 0;
static uint32_t g_replay_drops = 0;

static uint8_t g_peer_mac[6] = {0};      // 実効値（NVS or default）
static uint8_t g_default_mac[6] = {0};   // configure 時に渡された fallback
static int g_channel = kDefaultChannel;
static Stream* g_uart_port = nullptr;
static int g_led_pin = 2;
static const char* g_nvs_ns = "espnow";
static Preferences g_prefs;

// 受信側のリプレイ防止: 単調増加 seq のみ受理
static uint32_t g_last_rx_seq = 0;

static bool macIsZero(const uint8_t m[6]) {
  for (int i = 0; i < 6; ++i) if (m[i] != 0) return false;
  return true;
}

static void loadPeerFromNvs() {
  g_prefs.begin(g_nvs_ns, true);  // read-only
  uint8_t buf[6] = {0};
  size_t n = g_prefs.getBytes("peer", buf, sizeof(buf));
  int ch = g_prefs.getInt("ch", kDefaultChannel);
  g_prefs.end();

  if (n == 6 && !macIsZero(buf)) {
    memcpy(g_peer_mac, buf, 6);
  } else {
    memcpy(g_peer_mac, g_default_mac, 6);
  }
  g_channel = (ch >= 1 && ch <= 13) ? ch : kDefaultChannel;
}

static void savePeerToNvs(const uint8_t mac[6]) {
  g_prefs.begin(g_nvs_ns, false);
  g_prefs.putBytes("peer", mac, 6);
  g_prefs.end();
}

static void clearPeerInNvs() {
  g_prefs.begin(g_nvs_ns, false);
  g_prefs.remove("peer");
  g_prefs.end();
}

static void saveChannelToNvs(int ch) {
  g_prefs.begin(g_nvs_ns, false);
  g_prefs.putInt("ch", ch);
  g_prefs.end();
}

void configure(const uint8_t defaultPeerMac[6],
               Stream& uartPort,
               int ledPin,
               const char* nvsNamespace) {
  memcpy(g_default_mac, defaultPeerMac, 6);
  g_uart_port = &uartPort;
  g_led_pin = ledPin;
  if (nvsNamespace && *nvsNamespace) g_nvs_ns = nvsNamespace;
  g_tx_seq = 0;
  g_bad_frames = 0;
  g_sent_lines = 0;
  g_recv_lines = 0;
  g_replay_drops = 0;
  g_last_rx_seq = 0;
  loadPeerFromNvs();
}

bool getOwnMacAddress(uint8_t mac[6]) {
  return esp_wifi_get_mac(WIFI_IF_STA, mac) == ESP_OK;
}

void formatMacAddress(const uint8_t mac[6], char out[18]) {
  snprintf(out, 18, "%02X:%02X:%02X:%02X:%02X:%02X",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
}

bool parseMacAddress(const char* s, uint8_t out[6]) {
  if (!s) return false;
  unsigned int v[6];
  // ":" / "-" / 空白区切り、いずれも許容
  int n = sscanf(s, "%x:%x:%x:%x:%x:%x", &v[0], &v[1], &v[2], &v[3], &v[4], &v[5]);
  if (n != 6) {
    n = sscanf(s, "%x-%x-%x-%x-%x-%x", &v[0], &v[1], &v[2], &v[3], &v[4], &v[5]);
  }
  if (n != 6) return false;
  for (int i = 0; i < 6; ++i) {
    if (v[i] > 0xFF) return false;
    out[i] = (uint8_t)v[i];
  }
  return true;
}

void printMacAddresses() {
  uint8_t ownMac[6] = {0};
  if (!getOwnMacAddress(ownMac)) {
    g_uart_port->println("[ERR] failed to read local MAC");
    return;
  }
  char ownText[18], peerText[18];
  formatMacAddress(ownMac, ownText);
  formatMacAddress(g_peer_mac, peerText);
  g_uart_port->print("[MAC] self=");
  g_uart_port->print(ownText);
  g_uart_port->print(", peer=");
  g_uart_port->print(peerText);
  g_uart_port->print(", ch=");
  g_uart_port->println(g_channel);
}

bool sendLineFrame(const uint8_t* payload, uint16_t plen) {
  LineFrameHdr h{};
  h.ver = kProtocolVersion;
  h.type = kFrameTypeLine;
  h.tx_seq = ++g_tx_seq;
  h.payload_len = plen;
  h.crc16 = 0;

  uint8_t buf[sizeof(LineFrameHdr) + kLineMax];
  if (plen > sizeof(buf) - sizeof(LineFrameHdr)) return false;
  memcpy(buf, &h, sizeof(h));
  memcpy(buf + sizeof(h), payload, plen);
  (reinterpret_cast<LineFrameHdr*>(buf))->crc16 = crc16_ccitt(buf, sizeof(h) + plen);

  return esp_now_send(g_peer_mac, buf, sizeof(h) + plen) == ESP_OK;
}

void printStats() {
  g_uart_port->print("[STAT] sent=");
  g_uart_port->print(g_sent_lines);
  g_uart_port->print(", recv=");
  g_uart_port->print(g_recv_lines);
  g_uart_port->print(", bad=");
  g_uart_port->print(g_bad_frames);
  g_uart_port->print(", replay=");
  g_uart_port->println(g_replay_drops);
}

bool handleLocalCommand(const char* line) {
  if (strcmp(line, "/stat") == 0) {
    printStats();
    return true;
  }
  if (strcmp(line, "/mac") == 0) {
    printMacAddresses();
    return true;
  }
  if (strcmp(line, "/help") == 0) {
    g_uart_port->println("[INFO] local commands:");
    g_uart_port->println("[INFO]   /mac /stat /help");
    g_uart_port->println("[INFO]   /setpeer XX:XX:XX:XX:XX:XX  (NVS 保存して再起動)");
    g_uart_port->println("[INFO]   /unpair                     (NVS の peer をクリア)");
    g_uart_port->println("[INFO]   /channel <1-13>             (Wi-Fi チャネル変更)");
    return true;
  }
  if (strncmp(line, "/setpeer ", 9) == 0) {
    uint8_t m[6];
    if (!parseMacAddress(line + 9, m)) {
      g_uart_port->println("[ERR] invalid MAC; usage: /setpeer XX:XX:XX:XX:XX:XX");
      return true;
    }
    savePeerToNvs(m);
    g_uart_port->println("[INFO] peer saved, restarting...");
    delay(200);
    ESP.restart();
    return true;
  }
  if (strcmp(line, "/unpair") == 0) {
    clearPeerInNvs();
    g_uart_port->println("[INFO] peer cleared, restarting...");
    delay(200);
    ESP.restart();
    return true;
  }
  if (strncmp(line, "/channel ", 9) == 0) {
    int ch = atoi(line + 9);
    if (ch < 1 || ch > 13) {
      g_uart_port->println("[ERR] channel out of range (1-13)");
      return true;
    }
    saveChannelToNvs(ch);
    g_uart_port->println("[INFO] channel saved, restarting...");
    delay(200);
    ESP.restart();
    return true;
  }
  return false;
}

bool handleLocalCommandOn(Stream& replyTo, const char* line) {
  Stream* saved = g_uart_port;
  g_uart_port = &replyTo;
  bool handled = handleLocalCommand(line);
  g_uart_port = saved;
  return handled;
}

void pollLocalCommands(Stream& cmdStream) {
  static char buf[kLineMax + 1];
  static uint16_t idx = 0;
  while (cmdStream.available()) {
    int c = cmdStream.read();
    if (c < 0) break;
    if (c == '\r') continue;
    if (c == '\n') {
      if (idx > 0) {
        buf[idx] = '\0';
        // 認識できない行はサイレントに捨てる（=USB は local コマンド専用窓口）
        handleLocalCommandOn(cmdStream, buf);
        idx = 0;
      }
      continue;
    }
    if (idx < kLineMax) {
      buf[idx++] = static_cast<char>(c);
    } else {
      idx = 0;
    }
  }
}

void writeReceivedLine(const uint8_t* line, uint16_t len) {
  g_uart_port->write(line, len);
  g_uart_port->write('\n');
}

void handleReceivedLine(const uint8_t* line, uint16_t len) {
  writeReceivedLine(line, len);
}

void onRecv(const esp_now_recv_info_t*, const uint8_t* data, int len) {
  if (!isFrameSane(data, static_cast<size_t>(len))) {
    g_bad_frames++;
    return;
  }

  LineFrameHdr h{};
  memcpy(&h, data, sizeof(h));
  if (h.payload_len == 0 || h.payload_len > kLineMax) {
    g_bad_frames++;
    return;
  }

  // 単調増加 seq によるリプレイ防止 (送信側再起動で seq=1 から始まるので
  // 自分の last_rx よりちょうど 1 から再開していたら受け入れる)
  if (g_last_rx_seq != 0 && h.tx_seq <= g_last_rx_seq && h.tx_seq != 1) {
    g_replay_drops++;
    return;
  }
  g_last_rx_seq = h.tx_seq;

  const uint8_t* p = data + sizeof(LineFrameHdr);
  handleReceivedLine(p, h.payload_len);
  // LED は短時間トグルのみ（コールバック内で delay() しない）
  digitalWrite(g_led_pin, HIGH);
  digitalWrite(g_led_pin, LOW);
  g_recv_lines++;
}

// 初期化時の重大エラーは USB と data port の両方に出す（aircraft 側でも気づけるように）
static void diagErr(const char* tag, esp_err_t err) {
  Serial.print("[ERR] "); Serial.print(tag); Serial.print(": 0x"); Serial.println(err, HEX);
  Serial.flush();
  if (g_uart_port && g_uart_port != &Serial) {
    g_uart_port->print("[ERR] "); g_uart_port->print(tag); g_uart_port->print(": 0x");
    g_uart_port->println(err, HEX);
  }
}

void initializeEspNow() {
  WiFi.mode(WIFI_STA);
  // 3.x では WiFi.mode() が内部で esp_wifi_start() 済み。重ねて呼ぶと ESP_ERR_INVALID_STATE。
  esp_err_t err = esp_wifi_start();
  if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) diagErr("esp_wifi_start", err);

  err = esp_wifi_set_channel(g_channel, WIFI_SECOND_CHAN_NONE);
  if (err != ESP_OK) diagErr("esp_wifi_set_channel", err);

  WiFi.setSleep(false);

  err = esp_now_init();
  if (err != ESP_OK) { diagErr("esp_now_init", err); return; }

  err = esp_now_set_pmk(ESPNOW_PMK);
  if (err != ESP_OK) diagErr("esp_now_set_pmk", err);

  esp_now_register_recv_cb(onRecv);

  esp_now_peer_info_t peer{};
  memcpy(peer.peer_addr, g_peer_mac, 6);
  peer.channel = g_channel;
  peer.ifidx = WIFI_IF_STA;
  peer.encrypt = true;
  memcpy(peer.lmk, ESPNOW_LMK, 16);
  err = esp_now_add_peer(&peer);
  if (err != ESP_OK) diagErr("esp_now_add_peer", err);
}

void processUartLoop() {
  static char line[kLineMax + 1];
  static uint16_t idx = 0;

  while (g_uart_port->available()) {
    int c = g_uart_port->read();
    if (c < 0) break;
    if (c == '\r') continue;

    if (c == '\n') {
      if (idx > 0) {
        line[idx] = '\0';
        if (!handleLocalCommand(line)) {
          if (sendLineFrame(reinterpret_cast<const uint8_t*>(line), idx)) {
            g_sent_lines++;
          } else {
            g_uart_port->println("[ERR] send failed");
          }
        }
        idx = 0;
      }
      continue;
    }

    if (idx < kLineMax) {
      line[idx++] = static_cast<char>(c);
    } else {
      idx = 0;
      g_uart_port->println("[ERR] uart line too long");
    }
  }
}

}  // namespace espnow_uart_bridge

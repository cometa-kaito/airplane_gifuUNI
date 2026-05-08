#include "espnow_uart_bridge.h"

#include <WiFi.h>
#include <esp_wifi.h>
#include <string.h>

#include "uart_line_protocol.h"

namespace espnow_uart_bridge {

using namespace uart_line_bridge;

static constexpr int kChannel = 1;
static constexpr uint16_t kLineMax = 220;

static uint32_t g_tx_seq = 0;
static uint32_t g_bad_frames = 0;
static uint32_t g_sent_lines = 0;
static uint32_t g_recv_lines = 0;
static const uint8_t* g_peer_mac = nullptr;
static Stream* g_uart_port = nullptr;
static int g_led_pin = 2;

void configure(const uint8_t peerMac[6], Stream& uartPort, int ledPin) {
  g_peer_mac = peerMac;
  g_uart_port = &uartPort;
  g_led_pin = ledPin;
  g_tx_seq = 0;
  g_bad_frames = 0;
  g_sent_lines = 0;
  g_recv_lines = 0;
}

bool getOwnMacAddress(uint8_t mac[6]) {
  return esp_wifi_get_mac(WIFI_IF_STA, mac) == ESP_OK;
}

void formatMacAddress(const uint8_t mac[6], char out[18]) {
  snprintf(
    out,
    18,
    "%02X:%02X:%02X:%02X:%02X:%02X",
    mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]
  );
}

void printMacAddresses() {
  uint8_t ownMac[6] = {0};
  if (!getOwnMacAddress(ownMac)) {
    g_uart_port->println("[ERR] failed to read local MAC");
    return;
  }

  char ownMacText[18];
  char peerMacText[18];
  formatMacAddress(ownMac, ownMacText);
  formatMacAddress(g_peer_mac, peerMacText);
  g_uart_port->print("[MAC] self=");
  g_uart_port->print(ownMacText);
  g_uart_port->print(", peer=");
  g_uart_port->println(peerMacText);
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
  g_uart_port->print("[STAT] self sent=");
  g_uart_port->print(g_sent_lines);
  g_uart_port->print(", recv=");
  g_uart_port->print(g_recv_lines);
  g_uart_port->print(", bad=");
  g_uart_port->println(g_bad_frames);
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
    g_uart_port->println("[INFO] local commands: /stat, /mac, /help");
    return true;
  }
  return false;
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
  const uint8_t* p = data + sizeof(LineFrameHdr);
  if (h.payload_len == 0 || h.payload_len > kLineMax) {
    g_bad_frames++;
    return;
  }

  handleReceivedLine(p, h.payload_len);
  digitalWrite(g_led_pin, HIGH);
  delay(5);
  digitalWrite(g_led_pin, LOW);
  g_recv_lines++;
}

void initializeEspNow() {
  WiFi.mode(WIFI_STA);
  ESP_ERROR_CHECK(esp_wifi_start());
  ESP_ERROR_CHECK(esp_wifi_set_channel(kChannel, WIFI_SECOND_CHAN_NONE));
  WiFi.setSleep(false);

  ESP_ERROR_CHECK(esp_now_init());
  esp_now_register_recv_cb(onRecv);

  esp_now_peer_info_t peer{};
  memcpy(peer.peer_addr, g_peer_mac, 6);
  peer.channel = kChannel;
  peer.ifidx = WIFI_IF_STA;
  peer.encrypt = false;
  esp_now_add_peer(&peer);
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

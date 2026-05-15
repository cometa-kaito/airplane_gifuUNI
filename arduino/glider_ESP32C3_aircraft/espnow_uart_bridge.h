#pragma once

#include <Arduino.h>
#include <esp_now.h>
#include <stdint.h>

namespace espnow_uart_bridge {

// Stores board-specific runtime settings and resets bridge statistics.
// defaultPeerMac: コンパイル時の既定相手 MAC（NVS に保存値が無いときの fallback）
// nvsNamespace : Preferences の namespace 名（aircraft / ground で分ける）
void configure(const uint8_t defaultPeerMac[6],
               Stream& uartPort,
               int ledPin,
               const char* nvsNamespace);

// Reads the station MAC address of the local ESP device.
bool getOwnMacAddress(uint8_t mac[6]);

// Converts a 6-byte MAC address into a printable string.
void formatMacAddress(const uint8_t mac[6], char out[18]);

// 文字列 (例 "AA:BB:CC:DD:EE:FF") を 6 バイトに変換。失敗時 false。
bool parseMacAddress(const char* s, uint8_t out[6]);

// Prints the local and peer MAC addresses to the configured UART.
void printMacAddresses();

// Packs one UART line into a protocol frame and sends it over ESP-NOW.
bool sendLineFrame(const uint8_t* payload, uint16_t plen);

// Prints bridge traffic counters and frame error counts.
void printStats();

// Handles local slash commands such as /stat, /mac, /help, /setpeer, /unpair, /channel.
bool handleLocalCommand(const char* line);

// Same as handleLocalCommand, but reply messages are written to `replyTo`
// instead of the configured UART port. Useful when the aircraft side wants to
// service local commands typed into the USB Serial console (which is separate
// from the Serial1 data channel).
bool handleLocalCommandOn(Stream& replyTo, const char* line);

// Polls `cmdStream` for line-terminated input, runs each line through
// handleLocalCommandOn(cmdStream, ...), and silently drops anything that is
// not a recognised local command.
void pollLocalCommands(Stream& cmdStream);

// Writes one received line to the configured UART and appends a newline.
void writeReceivedLine(const uint8_t* line, uint16_t len);

// Entry point for processing one received payload line.
void handleReceivedLine(const uint8_t* line, uint16_t len);

// ESP-NOW receive callback that validates and forwards incoming frames.
void onRecv(const esp_now_recv_info_t*, const uint8_t* data, int len);

// Initializes Wi-Fi station mode, ESP-NOW, and the configured peer entry.
void initializeEspNow();

// Processes UART input, handles local commands, and transmits complete lines.
void processUartLoop();

}  // namespace espnow_uart_bridge

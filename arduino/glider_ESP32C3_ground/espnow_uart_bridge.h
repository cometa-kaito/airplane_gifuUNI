#pragma once

#include <Arduino.h>
#include <esp_now.h>
#include <stdint.h>

namespace espnow_uart_bridge {

// Stores board-specific runtime settings and resets bridge statistics.
void configure(const uint8_t peerMac[6], Stream& uartPort, int ledPin);

// Reads the station MAC address of the local ESP device.
bool getOwnMacAddress(uint8_t mac[6]);

// Converts a 6-byte MAC address into a printable string.
void formatMacAddress(const uint8_t mac[6], char out[18]);

// Prints the local and peer MAC addresses to the configured UART.
void printMacAddresses();

// Packs one UART line into a protocol frame and sends it over ESP-NOW.
bool sendLineFrame(const uint8_t* payload, uint16_t plen);

// Prints bridge traffic counters and frame error counts.
void printStats();

// Handles local slash commands such as /stat, /mac, and /help.
bool handleLocalCommand(const char* line);

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

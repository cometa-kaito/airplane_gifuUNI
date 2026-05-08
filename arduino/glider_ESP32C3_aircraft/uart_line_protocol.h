#pragma once

#include <stddef.h>
#include <stdint.h>

namespace uart_line_bridge {

extern const uint8_t kProtocolVersion;
extern const uint8_t kFrameTypeLine;

struct __attribute__((packed)) LineFrameHdr {
  uint8_t ver;
  uint8_t type;
  uint32_t tx_seq;
  uint16_t payload_len;
  uint16_t crc16;
};

// Updates a CRC-16/CCITT accumulator with one byte.
uint16_t crc16_ccitt_step(uint16_t crc, uint8_t byte);

// Calculates CRC-16/CCITT for a contiguous byte buffer.
uint16_t crc16_ccitt(const uint8_t* data, size_t len);

// Validates frame version, type, payload length, and CRC.
bool isFrameSane(const uint8_t* data, size_t len);

}  // namespace uart_line_bridge

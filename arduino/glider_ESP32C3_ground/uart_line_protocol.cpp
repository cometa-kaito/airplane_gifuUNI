#include "uart_line_protocol.h"

#include <string.h>

namespace uart_line_bridge {

const uint8_t kProtocolVersion = 1;
const uint8_t kFrameTypeLine = 1;

uint16_t crc16_ccitt_step(uint16_t crc, uint8_t byte) {
  crc ^= static_cast<uint16_t>(byte) << 8;
  for (int b = 0; b < 8; ++b) {
    crc = (crc & 0x8000) ? static_cast<uint16_t>((crc << 1) ^ 0x1021) : static_cast<uint16_t>(crc << 1);
  }
  return crc;
}

uint16_t crc16_ccitt(const uint8_t* data, size_t len) {
  uint16_t crc = 0xFFFF;
  for (size_t i = 0; i < len; ++i) {
    crc = crc16_ccitt_step(crc, data[i]);
  }
  return crc;
}

bool isFrameSane(const uint8_t* data, size_t len) {
  if (len < sizeof(LineFrameHdr)) return false;

  LineFrameHdr hdr{};
  memcpy(&hdr, data, sizeof(hdr));
  if (hdr.ver != kProtocolVersion) return false;
  if (hdr.type != kFrameTypeLine) return false;
  if (len != sizeof(LineFrameHdr) + hdr.payload_len) return false;

  const uint16_t expected_crc = hdr.crc16;
  hdr.crc16 = 0;

  uint16_t crc = crc16_ccitt(reinterpret_cast<const uint8_t*>(&hdr), sizeof(hdr));
  for (size_t i = 0; i < hdr.payload_len; ++i) {
    crc = crc16_ccitt_step(crc, data[sizeof(LineFrameHdr) + i]);
  }
  return crc == expected_crc;
}

}  // namespace uart_line_bridge

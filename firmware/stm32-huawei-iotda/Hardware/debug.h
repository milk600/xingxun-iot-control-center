#ifndef DEBUG_H
#define DEBUG_H

#include <stdint.h>

void Debug_Init(uint32_t baud, uint8_t mirrorToUsart2);
void Debug_Print(const char *text);
void Debug_PrintLine(const char *text);
void Debug_PrintUInt(uint32_t value);
void Debug_PrintInt(int32_t value);
void Debug_PrintHexByte(uint8_t value);
void Debug_PrintFloat3(uint16_t scaledValue);
void Debug_PrintBufferAscii(const uint8_t *data, uint16_t length);

#endif

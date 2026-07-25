#ifndef UTIL_H
#define UTIL_H

#include <stdint.h>

typedef struct
{
    char *buffer;
    uint16_t capacity;
    uint16_t length;
    uint8_t valid;
} TextBuilder;

uint16_t Util_StrLen(const char *text);
int Util_StrEqual(const char *left, const char *right);
void *Util_MemCopy(void *destination, const void *source, uint32_t length);
void *Util_MemSet(void *destination, int value, uint32_t length);
int Util_MemCompare(const void *left, const void *right, uint32_t length);

void TextBuilder_Init(TextBuilder *builder, char *buffer, uint16_t capacity);
void TextBuilder_Append(TextBuilder *builder, const char *text);
void TextBuilder_AppendChar(TextBuilder *builder, char value);
void TextBuilder_AppendUInt(TextBuilder *builder, uint32_t value);
void TextBuilder_AppendInt(TextBuilder *builder, int32_t value);
void TextBuilder_AppendEscapedAT(TextBuilder *builder, const char *text);
const char *TextBuilder_Text(TextBuilder *builder);
uint16_t TextBuilder_Length(const TextBuilder *builder);
int TextBuilder_IsValid(const TextBuilder *builder);

#endif

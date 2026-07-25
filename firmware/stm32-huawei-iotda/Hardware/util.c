#include "util.h"

uint16_t Util_StrLen(const char *text)
{
    uint16_t length = 0U;
    if (text == 0)
    {
        return 0U;
    }
    while (text[length] != '\0')
    {
        length++;
    }
    return length;
}

int Util_StrEqual(const char *left, const char *right)
{
    uint16_t index = 0U;
    if ((left == 0) || (right == 0))
    {
        return 0;
    }
    while ((left[index] != '\0') && (right[index] != '\0'))
    {
        if (left[index] != right[index])
        {
            return 0;
        }
        index++;
    }
    return (left[index] == right[index]) ? 1 : 0;
}

void *Util_MemCopy(void *destination, const void *source, uint32_t length)
{
    uint8_t *dst = (uint8_t *)destination;
    const uint8_t *src = (const uint8_t *)source;
    uint32_t index;
    for (index = 0U; index < length; index++)
    {
        dst[index] = src[index];
    }
    return destination;
}

void *Util_MemSet(void *destination, int value, uint32_t length)
{
    uint8_t *dst = (uint8_t *)destination;
    uint32_t index;
    for (index = 0U; index < length; index++)
    {
        dst[index] = (uint8_t)value;
    }
    return destination;
}

int Util_MemCompare(const void *left, const void *right, uint32_t length)
{
    const uint8_t *a = (const uint8_t *)left;
    const uint8_t *b = (const uint8_t *)right;
    uint32_t index;
    for (index = 0U; index < length; index++)
    {
        if (a[index] != b[index])
        {
            return (a[index] < b[index]) ? -1 : 1;
        }
    }
    return 0;
}

static void TextBuilder_Push(TextBuilder *builder, char value)
{
    if ((builder == 0) || (builder->valid == 0U))
    {
        return;
    }
    if ((uint16_t)(builder->length + 1U) >= builder->capacity)
    {
        builder->valid = 0U;
        return;
    }
    builder->buffer[builder->length++] = value;
    builder->buffer[builder->length] = '\0';
}

void TextBuilder_Init(TextBuilder *builder, char *buffer, uint16_t capacity)
{
    if (builder == 0)
    {
        return;
    }
    builder->buffer = buffer;
    builder->capacity = capacity;
    builder->length = 0U;
    builder->valid = ((buffer != 0) && (capacity > 0U)) ? 1U : 0U;
    if (builder->valid != 0U)
    {
        builder->buffer[0] = '\0';
    }
}

void TextBuilder_Append(TextBuilder *builder, const char *text)
{
    uint16_t index = 0U;
    if (text == 0)
    {
        if (builder != 0)
        {
            builder->valid = 0U;
        }
        return;
    }
    while (text[index] != '\0')
    {
        TextBuilder_Push(builder, text[index++]);
    }
}

void TextBuilder_AppendChar(TextBuilder *builder, char value)
{
    TextBuilder_Push(builder, value);
}

void TextBuilder_AppendUInt(TextBuilder *builder, uint32_t value)
{
    char digits[10];
    uint8_t count = 0U;
    if (value == 0U)
    {
        TextBuilder_Push(builder, '0');
        return;
    }
    while ((value > 0U) && (count < sizeof(digits)))
    {
        digits[count++] = (char)('0' + (value % 10U));
        value /= 10U;
    }
    while (count > 0U)
    {
        TextBuilder_Push(builder, digits[--count]);
    }
}

void TextBuilder_AppendInt(TextBuilder *builder, int32_t value)
{
    uint32_t magnitude;
    if (value < 0)
    {
        TextBuilder_Push(builder, '-');
        magnitude = (uint32_t)(-(value + 1));
        magnitude += 1U;
    }
    else
    {
        magnitude = (uint32_t)value;
    }
    TextBuilder_AppendUInt(builder, magnitude);
}

void TextBuilder_AppendEscapedAT(TextBuilder *builder, const char *text)
{
    uint16_t index = 0U;
    char value;
    if (text == 0)
    {
        builder->valid = 0U;
        return;
    }
    while (text[index] != '\0')
    {
        value = text[index++];
        if ((value == '\\') || (value == '"') || (value == ','))
        {
            TextBuilder_Push(builder, '\\');
        }
        TextBuilder_Push(builder, value);
    }
}

const char *TextBuilder_Text(TextBuilder *builder)
{
    if ((builder == 0) || (builder->valid == 0U))
    {
        return "";
    }
    builder->buffer[builder->length] = '\0';
    return builder->buffer;
}

uint16_t TextBuilder_Length(const TextBuilder *builder)
{
    return (builder != 0) ? builder->length : 0U;
}

int TextBuilder_IsValid(const TextBuilder *builder)
{
    return ((builder != 0) && (builder->valid != 0U)) ? 1 : 0;
}

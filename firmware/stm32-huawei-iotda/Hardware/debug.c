#include "debug.h"
#include "uart.h"

static void Debug_WriteByte(uint8_t value)
{
    UART_WriteByte(USART1, value);
    if (UART_DebugMirrorEnabled() != 0U)
    {
        UART_WriteByte(USART2, value);
    }
}

void Debug_Init(uint32_t baud, uint8_t mirrorToUsart2)
{
    UART_InitDebug(baud, mirrorToUsart2);
}

void Debug_Print(const char *text)
{
    while ((text != 0) && (*text != '\0'))
    {
        Debug_WriteByte((uint8_t)*text++);
    }
}

void Debug_PrintLine(const char *text)
{
    Debug_Print(text);
    Debug_Print("\r\n");
}

void Debug_PrintUInt(uint32_t value)
{
    char digits[10];
    uint8_t count = 0U;
    if (value == 0U)
    {
        Debug_WriteByte('0');
        return;
    }
    while ((value > 0U) && (count < sizeof(digits)))
    {
        digits[count++] = (char)('0' + (value % 10U));
        value /= 10U;
    }
    while (count > 0U)
    {
        Debug_WriteByte((uint8_t)digits[--count]);
    }
}

void Debug_PrintInt(int32_t value)
{
    uint32_t magnitude;
    if (value < 0)
    {
        Debug_WriteByte('-');
        magnitude = (uint32_t)(-(value + 1));
        magnitude += 1U;
    }
    else
    {
        magnitude = (uint32_t)value;
    }
    Debug_PrintUInt(magnitude);
}

void Debug_PrintHexByte(uint8_t value)
{
    static const char digits[] = "0123456789ABCDEF";
    Debug_WriteByte((uint8_t)digits[(value >> 4U) & 0x0FU]);
    Debug_WriteByte((uint8_t)digits[value & 0x0FU]);
}

void Debug_PrintFloat3(uint16_t scaledValue)
{
    uint16_t intPart = scaledValue / 1000U;
    uint16_t fracPart = scaledValue % 1000U;

    Debug_PrintUInt(intPart);
    Debug_WriteByte('.');
    Debug_WriteByte((uint8_t)('0' + (fracPart / 100U)));
    fracPart %= 100U;
    Debug_WriteByte((uint8_t)('0' + (fracPart / 10U)));
    Debug_WriteByte((uint8_t)('0' + (fracPart % 10U)));
}

void Debug_PrintBufferAscii(const uint8_t *data, uint16_t length)
{
    uint16_t index;
    uint8_t value;
    for (index = 0U; index < length; index++)
    {
        value = data[index];
        if ((value == '\r') || (value == '\n') || ((value >= 32U) && (value <= 126U)))
        {
            Debug_WriteByte(value);
        }
        else
        {
            Debug_WriteByte('.');
        }
    }
}

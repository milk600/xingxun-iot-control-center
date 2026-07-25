#include "esp8266.h"
#include "app_config.h"
#include "debug.h"
#include "delay.h"
#include "uart.h"
#include "util.h"

#define ESP_RESPONSE_SIZE 768U

static uint8_t g_response[ESP_RESPONSE_SIZE];
static uint16_t g_responseLength = 0U;

static int BufferContains(const uint8_t *buffer, uint16_t length, const char *text)
{
    uint16_t textLength = Util_StrLen(text);
    uint16_t index;
    if ((textLength == 0U) || (length < textLength))
    {
        return 0;
    }
    for (index = 0U; index <= (uint16_t)(length - textLength); index++)
    {
        if (Util_MemCompare(&buffer[index], text, textLength) == 0)
        {
            return 1;
        }
    }
    return 0;
}

static void LogATResponse(const uint8_t *response, uint16_t length)
{
#if ESP_AT_DEBUG
    Debug_Print("[ESP RX] ");
    Debug_PrintBufferAscii(response, length);
    if ((length == 0U) || (response[length - 1U] != '\n'))
    {
        Debug_Print("\r\n");
    }
#else
    (void)response;
    (void)length;
#endif
}

static int CollectUntil(const char *success1,
                        const char *success2,
                        uint32_t timeoutMs,
                        uint8_t *output,
                        uint16_t outputCapacity,
                        uint16_t *outputLength)
{
    uint32_t start = Millis();
    uint16_t length = 0U;
    uint8_t value;

    while ((uint32_t)(Millis() - start) < timeoutMs)
    {
        if (UART_ReadByteTimeout(ESP_UART, &value, 2U))
        {
            if (length < outputCapacity)
            {
                output[length++] = value;
            }
            if ((success1 != 0) && BufferContains(output, length, success1))
            {
                if (outputLength != 0)
                {
                    *outputLength = length;
                }
                return 1;
            }
            if ((success2 != 0) && BufferContains(output, length, success2))
            {
                if (outputLength != 0)
                {
                    *outputLength = length;
                }
                return 1;
            }
            if (BufferContains(output, length, "busy p"))
            {
                /* ESP is still processing a previous command. Discard this
                 * notice and keep waiting within the remaining timeout for the
                 * real reply (OK / CONNECT / ERROR). Treating busy p as a hard
                 * error causes a cascade: every subsequent command also gets
                 * busy p because the ESP never finishes the pending op. */
                length = 0U;
            }
            else if (BufferContains(output, length, "ERROR") ||
                     BufferContains(output, length, "FAIL") ||
                     BufferContains(output, length, "link is not valid"))
            {
                if (outputLength != 0)
                {
                    *outputLength = length;
                }
                return -1;
            }
        }
    }
    if (outputLength != 0)
    {
        *outputLength = length;
    }
    return 0;
}

static int SendCommand(const char *command,
                       const char *success1,
                       const char *success2,
                       uint32_t timeoutMs)
{
    uint16_t responseLength = 0U;
    int result;

    UART_FlushRx(ESP_UART);
#if ESP_AT_DEBUG
    Debug_Print("[ESP TX] ");
    Debug_PrintLine(command);
#endif
    UART_WriteString(ESP_UART, command);
    UART_WriteString(ESP_UART, "\r\n");
    result = CollectUntil(success1, success2, timeoutMs,
                          g_response, ESP_RESPONSE_SIZE, &responseLength);
    g_responseLength = responseLength;
    LogATResponse(g_response, responseLength);
    return (result == 1) ? 1 : 0;
}

/*
 * ESP-AT echoes commands by default. At 115200 baud the echoed bytes can
 * arrive while the MCU is still transmitting the command. USART3 has only a
 * one-byte receive data register, so a polling-only receiver can overrun and
 * lose one character (the observed response was typically "AT\r\nK", with
 * the 'O' from "OK" missing).
 *
 * Send ATE0 without parsing its reply first. On the correct baud this disables
 * echo, after which all normal commands have short, reliable replies. On an
 * incorrect baud the bytes are ignored, so this is safe during auto-baud scan.
 */
static void DisableEchoBlind(void)
{
    UART_FlushRx(ESP_UART);
    UART_WriteString(ESP_UART, "ATE0\r\n");
    Delay_ms(250U);
    UART_FlushRx(ESP_UART);
}

static int TestATAtBaud(uint32_t baud)
{
    uint8_t attempt;

    UART_SetEspBaud(baud);
    Delay_ms(100U);
    DisableEchoBlind();

    for (attempt = 0U; attempt < 3U; attempt++)
    {
        if (SendCommand("AT", "OK", 0, 1200U))
        {
            return 1;
        }
        Delay_ms(150U);
        DisableEchoBlind();
    }
    return 0;
}

int ESP8266_InitAutoBaud(uint32_t preferredBaud, uint32_t *detectedBaud)
{
    static const uint32_t candidates[] = {115200U, 9600U, 57600U, 38400U};
    uint8_t index;

    UART_InitEsp(preferredBaud);
    Delay_ms(1800U);

    if (TestATAtBaud(preferredBaud))
    {
        if (detectedBaud != 0)
        {
            *detectedBaud = preferredBaud;
        }
    }
    else
    {
        for (index = 0U; index < (uint8_t)(sizeof(candidates) / sizeof(candidates[0])); index++)
        {
            if (candidates[index] == preferredBaud)
            {
                continue;
            }
            if (TestATAtBaud(candidates[index]))
            {
                if (detectedBaud != 0)
                {
                    *detectedBaud = candidates[index];
                }
                break;
            }
        }
        if (index >= (uint8_t)(sizeof(candidates) / sizeof(candidates[0])))
        {
            return 0;
        }
    }

    (void)SendCommand("ATE0", "OK", 0, 1500U);
    if (!SendCommand("AT+CWMODE=1", "OK", "no change", 2000U))
    {
        return 0;
    }
    if (!SendCommand("AT+CIPMUX=0", "OK", 0, 2000U))
    {
        return 0;
    }
    if (!SendCommand("AT+CIPMODE=0", "OK", 0, 2000U))
    {
        return 0;
    }
    return 1;
}

int ESP8266_JoinWiFi(const char *ssid, const char *password)
{
    char command[256];
    TextBuilder builder;

    TextBuilder_Init(&builder, command, sizeof(command));
    TextBuilder_Append(&builder, "AT+CWJAP=\"");
    TextBuilder_AppendEscapedAT(&builder, ssid);
    TextBuilder_Append(&builder, "\",\"");
    TextBuilder_AppendEscapedAT(&builder, password);
    TextBuilder_AppendChar(&builder, '"');
    if (!TextBuilder_IsValid(&builder))
    {
        return 0;
    }
    if (SendCommand(TextBuilder_Text(&builder), "WIFI GOT IP", "OK", 40000U))
    {
        /* Let the ESP network stack settle (DHCP / DNS) before issuing TCP
         * commands, otherwise CIPSTART may return busy p right after GOT IP. */
        Delay_ms(1000U);
        return 1;
    }

    Debug_Print("[WIFI] Join failed: ");
    if (BufferContains(g_response, g_responseLength, "+CWJAP:1"))
    {
        Debug_PrintLine("timeout (check signal, channel and hotspot).");
    }
    else if (BufferContains(g_response, g_responseLength, "+CWJAP:2"))
    {
        Debug_PrintLine("wrong password.");
    }
    else if (BufferContains(g_response, g_responseLength, "+CWJAP:3"))
    {
        Debug_PrintLine("SSID not found (ensure 2.4 GHz and SSID broadcast).");
    }
    else if (BufferContains(g_response, g_responseLength, "+CWJAP:4"))
    {
        Debug_PrintLine("association failed (try WPA2 instead of WPA3).");
    }
    else
    {
        Debug_PrintLine("unknown; inspect the complete ESP RX line above.");
    }
    if (UART_EspRxOverflowCount() != 0U)
    {
        Debug_Print("[WIFI] USART3 ring overflow count=");
        Debug_PrintUInt(UART_EspRxOverflowCount());
        Debug_PrintLine("");
    }
    return 0;
}

void ESP8266_CloseTCP(void)
{
    (void)SendCommand("AT+CIPCLOSE", "OK", "CLOSED", 2000U);
}

int ESP8266_OpenTCP(const char *host, uint16_t port)
{
    char command[256];
    TextBuilder builder;
    uint8_t attempt;

    ESP8266_CloseTCP();
    /* Give the ESP network stack time to settle after Wi-Fi join. Without
     * this, CIPSTART fired right after GOT IP returns busy p because the
     * ESP is still finishing DHCP / DNS internally. */
    Delay_ms(1000U);

    TextBuilder_Init(&builder, command, sizeof(command));
    TextBuilder_Append(&builder, "AT+CIPSTART=\"TCP\",\"");
    TextBuilder_AppendEscapedAT(&builder, host);
    TextBuilder_Append(&builder, "\",");
    TextBuilder_AppendUInt(&builder, port);
    if (!TextBuilder_IsValid(&builder))
    {
        return 0;
    }
    /* Retry CIPSTART: with the busy-p tolerance in CollectUntil, a single
     * attempt already waits through transient busy, but a second/third try
     * covers the case where the ESP rejected the command outright. */
    for (attempt = 0U; attempt < 3U; attempt++)
    {
        if (SendCommand(TextBuilder_Text(&builder), "CONNECT", "ALREADY CONNECTED", 10000U))
        {
            return 1;
        }
        ESP8266_CloseTCP();
        Delay_ms(1000U);
    }
    return 0;
}

int ESP8266_SendTCP(const uint8_t *data,
                    uint16_t length,
                    uint8_t *response,
                    uint16_t responseCapacity,
                    uint16_t *responseLength,
                    uint32_t timeoutMs)
{
    char command[40];
    TextBuilder builder;
    uint16_t promptLength = 0U;
    uint16_t sendLength = 0U;
    uint16_t copyLength;
    int result;

    if ((data == 0) || (length == 0U))
    {
        return 0;
    }

    TextBuilder_Init(&builder, command, sizeof(command));
    TextBuilder_Append(&builder, "AT+CIPSEND=");
    TextBuilder_AppendUInt(&builder, length);
    if (!TextBuilder_IsValid(&builder))
    {
        return 0;
    }

    UART_FlushRx(ESP_UART);
#if ESP_AT_DEBUG
    Debug_Print("[ESP TX] ");
    Debug_PrintLine(TextBuilder_Text(&builder));
#endif
    UART_WriteString(ESP_UART, TextBuilder_Text(&builder));
    UART_WriteString(ESP_UART, "\r\n");

    result = CollectUntil(">", 0, 5000U,
                          g_response, ESP_RESPONSE_SIZE, &promptLength);
    LogATResponse(g_response, promptLength);
    if (result != 1)
    {
        return 0;
    }

    UART_Write(ESP_UART, data, length);
    result = CollectUntil("SEND OK", 0, timeoutMs,
                          g_response, ESP_RESPONSE_SIZE, &sendLength);
    LogATResponse(g_response, sendLength);

    if (responseLength != 0)
    {
        *responseLength = 0U;
    }
    if ((response != 0) && (responseCapacity > 0U))
    {
        copyLength = (sendLength < responseCapacity) ? sendLength : responseCapacity;
        Util_MemCopy(response, g_response, copyLength);
        if (responseLength != 0)
        {
            *responseLength = copyLength;
        }
    }
    return (result == 1) ? 1 : 0;
}

int ESP8266_ResponseHasMQTTConnack(const uint8_t *response,
                                   uint16_t length,
                                   uint8_t *returnCode)
{
    uint16_t index;
    if ((response == 0) || (length < 4U))
    {
        return 0;
    }
    for (index = 0U; index <= (uint16_t)(length - 4U); index++)
    {
        if ((response[index] == 0x20U) &&
            (response[index + 1U] == 0x02U) &&
            (response[index + 2U] == 0x00U))
        {
            if (returnCode != 0)
            {
                *returnCode = response[index + 3U];
            }
            return 1;
        }
    }
    return 0;
}

int ESP8266_ResponseHasMQTTPingResp(const uint8_t *response, uint16_t length)
{
    uint16_t index;
    if ((response == 0) || (length < 2U))
    {
        return 0;
    }
    for (index = 0U; index <= (uint16_t)(length - 2U); index++)
    {
        if ((response[index] == 0xD0U) && (response[index + 1U] == 0x00U))
        {
            return 1;
        }
    }
    return 0;
}

int ESP8266_WaitMQTTConnack(uint8_t *returnCode, uint32_t timeoutMs)
{
    uint8_t window[4] = {0U, 0U, 0U, 0U};
    uint8_t count = 0U;
    uint8_t value;
    uint32_t start = Millis();

    while ((uint32_t)(Millis() - start) < timeoutMs)
    {
        if (UART_ReadByteTimeout(ESP_UART, &value, 5U))
        {
            if (count < 4U)
            {
                window[count++] = value;
            }
            else
            {
                window[0] = window[1];
                window[1] = window[2];
                window[2] = window[3];
                window[3] = value;
            }
            if ((count == 4U) &&
                (window[0] == 0x20U) &&
                (window[1] == 0x02U) &&
                (window[2] == 0x00U))
            {
                if (returnCode != 0)
                {
                    *returnCode = window[3];
                }
                return 1;
            }
        }
    }
    return 0;
}

int ESP8266_WaitMQTTPingResp(uint32_t timeoutMs)
{
    uint8_t previous = 0U;
    uint8_t value;
    uint8_t havePrevious = 0U;
    uint32_t start = Millis();

    while ((uint32_t)(Millis() - start) < timeoutMs)
    {
        if (UART_ReadByteTimeout(ESP_UART, &value, 5U))
        {
            if ((havePrevious != 0U) && (previous == 0xD0U) && (value == 0x00U))
            {
                return 1;
            }
            previous = value;
            havePrevious = 1U;
        }
    }
    return 0;
}

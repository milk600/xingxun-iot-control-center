#include "huawei_iotda.h"
#include "app_config.h"
#include "debug.h"
#include "esp8266.h"
#include "sha256.h"
#include "util.h"

#define MQTT_PACKET_BUFFER_SIZE 768U
#define MQTT_RESPONSE_SIZE      256U
#define MQTT_KEEPALIVE_SECONDS  120U

static uint8_t g_packet[MQTT_PACKET_BUFFER_SIZE];
static uint8_t g_response[MQTT_RESPONSE_SIZE];
static char g_clientId[320];
static char g_password[65];
static uint8_t g_connected = 0U;
static uint8_t g_lastConnack = 0xFFU;

static uint16_t MQTT_EncodeRemainingLength(uint32_t value, uint8_t *output)
{
    uint16_t count = 0U;
    uint8_t encoded;
    do
    {
        encoded = (uint8_t)(value & 0x7FU);
        value >>= 7U;
        if (value > 0U)
        {
            encoded |= 0x80U;
        }
        output[count++] = encoded;
    } while ((value > 0U) && (count < 4U));
    return count;
}

static uint16_t MQTT_WriteString(uint8_t *buffer,
                                 uint16_t offset,
                                 uint16_t capacity,
                                 const char *text)
{
    uint16_t length = Util_StrLen(text);
    if ((uint32_t)offset + 2U + length > capacity)
    {
        return 0U;
    }
    buffer[offset++] = (uint8_t)(length >> 8U);
    buffer[offset++] = (uint8_t)(length & 0xFFU);
    Util_MemCopy(&buffer[offset], text, length);
    return (uint16_t)(offset + length);
}

static int BuildAuthentication(void)
{
    TextBuilder builder;
    TextBuilder_Init(&builder, g_clientId, sizeof(g_clientId));
    TextBuilder_Append(&builder, IOTDA_DEVICE_ID);
    TextBuilder_Append(&builder, "_0_0_");
    TextBuilder_Append(&builder, IOTDA_AUTH_TIMESTAMP);
    if (!TextBuilder_IsValid(&builder))
    {
        return 0;
    }

    /* Huawei IoTDA: HMAC-SHA256 key=timestamp, message=device secret. */
    HMAC_SHA256_Hex((const uint8_t *)IOTDA_AUTH_TIMESTAMP,
                    Util_StrLen(IOTDA_AUTH_TIMESTAMP),
                    (const uint8_t *)IOTDA_DEVICE_SECRET,
                    Util_StrLen(IOTDA_DEVICE_SECRET),
                    g_password);
    return 1;
}

static uint16_t MQTT_BuildConnectPacket(void)
{
    uint16_t clientLength = Util_StrLen(g_clientId);
    uint16_t usernameLength = Util_StrLen(IOTDA_DEVICE_ID);
    uint16_t passwordLength = Util_StrLen(g_password);
    uint32_t remainingLength = 10U + 2U + clientLength +
                               2U + usernameLength + 2U + passwordLength;
    uint16_t remainingBytes;
    uint16_t offset;

    g_packet[0] = 0x10U;
    remainingBytes = MQTT_EncodeRemainingLength(remainingLength, &g_packet[1]);
    offset = (uint16_t)(1U + remainingBytes);

    g_packet[offset++] = 0x00U;
    g_packet[offset++] = 0x04U;
    g_packet[offset++] = 'M';
    g_packet[offset++] = 'Q';
    g_packet[offset++] = 'T';
    g_packet[offset++] = 'T';
    g_packet[offset++] = 0x04U; /* MQTT 3.1.1. */
    g_packet[offset++] = 0xC2U; /* user + password + clean session. */
    g_packet[offset++] = (uint8_t)(MQTT_KEEPALIVE_SECONDS >> 8U);
    g_packet[offset++] = (uint8_t)(MQTT_KEEPALIVE_SECONDS & 0xFFU);

    offset = MQTT_WriteString(g_packet, offset, MQTT_PACKET_BUFFER_SIZE, g_clientId);
    if (offset == 0U) return 0U;
    offset = MQTT_WriteString(g_packet, offset, MQTT_PACKET_BUFFER_SIZE, IOTDA_DEVICE_ID);
    if (offset == 0U) return 0U;
    offset = MQTT_WriteString(g_packet, offset, MQTT_PACKET_BUFFER_SIZE, g_password);
    return offset;
}

static uint16_t MQTT_BuildPublishPacket(const char *topic, const char *payload)
{
    uint16_t topicLength = Util_StrLen(topic);
    uint16_t payloadLength = Util_StrLen(payload);
    uint32_t remainingLength = 2U + topicLength + payloadLength;
    uint16_t remainingBytes;
    uint16_t offset;

    if ((remainingLength + 5U) > MQTT_PACKET_BUFFER_SIZE)
    {
        return 0U;
    }

    g_packet[0] = 0x30U; /* PUBLISH, QoS 0. */
    remainingBytes = MQTT_EncodeRemainingLength(remainingLength, &g_packet[1]);
    offset = (uint16_t)(1U + remainingBytes);
    g_packet[offset++] = (uint8_t)(topicLength >> 8U);
    g_packet[offset++] = (uint8_t)(topicLength & 0xFFU);
    Util_MemCopy(&g_packet[offset], topic, topicLength);
    offset = (uint16_t)(offset + topicLength);
    Util_MemCopy(&g_packet[offset], payload, payloadLength);
    return (uint16_t)(offset + payloadLength);
}

int HuaweiIoTDA_ConfigLooksValid(void)
{
    if ((Util_StrLen(WIFI_SSID) == 0U) ||
        (Util_StrLen(WIFI_PASSWORD) == 0U) ||
        (Util_StrLen(IOTDA_BROKER_HOST) == 0U) ||
        (Util_StrLen(IOTDA_DEVICE_ID) == 0U) ||
        (Util_StrLen(IOTDA_DEVICE_SECRET) == 0U) ||
        (Util_StrLen(IOTDA_SERVICE_ID) == 0U) ||
        (Util_StrLen(IOTDA_AUTH_TIMESTAMP) != 10U))
    {
        return 0;
    }
    return 1;
}

int HuaweiIoTDA_Connect(void)
{
    uint16_t packetLength;
    uint16_t responseLength = 0U;
    uint8_t connackCode = 0xFFU;

    g_connected = 0U;
    g_lastConnack = 0xFFU;
    if (!HuaweiIoTDA_ConfigLooksValid() || !BuildAuthentication())
    {
        return 0;
    }

#if CLOUD_DEBUG_AUTH
    Debug_Print("[IoTDA] ClientId: ");
    Debug_PrintLine(g_clientId);
    Debug_Print("[IoTDA] Username: ");
    Debug_PrintLine(IOTDA_DEVICE_ID);
    Debug_Print("[IoTDA] Password(HMAC): ");
    Debug_PrintLine(g_password);
#endif

    if (!ESP8266_OpenTCP(IOTDA_BROKER_HOST, IOTDA_BROKER_PORT))
    {
        return 0;
    }

    packetLength = MQTT_BuildConnectPacket();
    if (packetLength == 0U)
    {
        return 0;
    }

    if (!ESP8266_SendTCP(g_packet, packetLength,
                         g_response, MQTT_RESPONSE_SIZE, &responseLength, 10000U))
    {
        return 0;
    }

    if (!ESP8266_ResponseHasMQTTConnack(g_response, responseLength, &connackCode))
    {
        if (!ESP8266_WaitMQTTConnack(&connackCode, 8000U))
        {
            return 0;
        }
    }
    g_lastConnack = connackCode;
    if (connackCode != 0U)
    {
        return 0;
    }
    g_connected = 1U;
    return 1;
}

static void AppendFloat3(TextBuilder *builder, uint16_t scaledValue)
{
    uint16_t intPart = scaledValue / 1000U;
    uint16_t fracPart = scaledValue % 1000U;
    char buffer[12];
    uint8_t pos = 0U;
    uint8_t i;

    if (intPart == 0U)
    {
        buffer[pos++] = '0';
    }
    else
    {
        char rev[6];
        uint8_t rlen = 0U;
        while (intPart > 0U)
        {
            rev[rlen++] = (char)('0' + (intPart % 10U));
            intPart /= 10U;
        }
        for (i = rlen; i > 0U; i--)
        {
            buffer[pos++] = rev[i - 1U];
        }
    }

    buffer[pos++] = '.';
    buffer[pos++] = (char)('0' + (fracPart / 100U));
    fracPart %= 100U;
    buffer[pos++] = (char)('0' + (fracPart / 10U));
    buffer[pos++] = (char)('0' + (fracPart % 10U));
    buffer[pos] = '\0';

    TextBuilder_Append(builder, buffer);
}

int HuaweiIoTDA_Report(int temperature,
                       int humidity,
                       uint16_t lightRaw,
                       uint8_t lightPercent,
                       uint16_t tvoc,
                       uint16_t ch2o,
                       uint16_t co2)
{
    char topic[384];
    char payload[512];
    TextBuilder builder;
    uint16_t packetLength;
    uint16_t responseLength = 0U;

    if (g_connected == 0U)
    {
        return 0;
    }

    TextBuilder_Init(&builder, topic, sizeof(topic));
    TextBuilder_Append(&builder, "$oc/devices/");
    TextBuilder_Append(&builder, IOTDA_DEVICE_ID);
    TextBuilder_Append(&builder, "/sys/properties/report");
    if (!TextBuilder_IsValid(&builder))
    {
        return 0;
    }

    TextBuilder_Init(&builder, payload, sizeof(payload));
    TextBuilder_Append(&builder, "{\"services\":[{\"service_id\":\"");
    TextBuilder_Append(&builder, IOTDA_SERVICE_ID);
    TextBuilder_Append(&builder, "\",\"properties\":{\"temperature\":");
    TextBuilder_AppendInt(&builder, temperature);
    TextBuilder_Append(&builder, ",\"humidity\":");
    TextBuilder_AppendInt(&builder, humidity);
    TextBuilder_Append(&builder, ",\"lightRaw\":");
    TextBuilder_AppendUInt(&builder, lightRaw);
    TextBuilder_Append(&builder, ",\"lightPercent\":");
    TextBuilder_AppendUInt(&builder, lightPercent);
    TextBuilder_Append(&builder, ",\"TVOC\":");
    AppendFloat3(&builder, tvoc);
    TextBuilder_Append(&builder, ",\"ch2o\":");
    AppendFloat3(&builder, ch2o);
    TextBuilder_Append(&builder, ",\"co2\":");
    TextBuilder_AppendUInt(&builder, co2);
    TextBuilder_Append(&builder, "}}]}");
    if (!TextBuilder_IsValid(&builder))
    {
        return 0;
    }

#if CLOUD_DEBUG_PAYLOAD
    Debug_Print("[IoTDA] Topic: ");
    Debug_PrintLine(topic);
    Debug_Print("[IoTDA] JSON: ");
    Debug_PrintLine(payload);
#endif

    packetLength = MQTT_BuildPublishPacket(topic, payload);
    if (packetLength == 0U)
    {
        return 0;
    }

    if (!ESP8266_SendTCP(g_packet, packetLength,
                         g_response, MQTT_RESPONSE_SIZE, &responseLength, 8000U))
    {
        g_connected = 0U;
        return 0;
    }
    return 1;
}

int HuaweiIoTDA_Ping(void)
{
    static const uint8_t pingPacket[2] = {0xC0U, 0x00U};
    uint16_t responseLength = 0U;
    if (g_connected == 0U)
    {
        return 0;
    }
    if (!ESP8266_SendTCP(pingPacket, 2U,
                         g_response, MQTT_RESPONSE_SIZE, &responseLength, 5000U))
    {
        g_connected = 0U;
        return 0;
    }
    /* A missing PINGRESP is treated as a lost connection. */
    if (!ESP8266_ResponseHasMQTTPingResp(g_response, responseLength))
    {
        if (!ESP8266_WaitMQTTPingResp(5000U))
        {
            g_connected = 0U;
            return 0;
        }
    }
    return 1;
}

void HuaweiIoTDA_Disconnect(void)
{
    static const uint8_t disconnectPacket[2] = {0xE0U, 0x00U};
    uint16_t responseLength = 0U;
    if (g_connected != 0U)
    {
        (void)ESP8266_SendTCP(disconnectPacket, 2U,
                              g_response, MQTT_RESPONSE_SIZE, &responseLength, 2000U);
    }
    ESP8266_CloseTCP();
    g_connected = 0U;
}

uint8_t HuaweiIoTDA_IsConnected(void)
{
    return g_connected;
}

uint8_t HuaweiIoTDA_LastConnackCode(void)
{
    return g_lastConnack;
}

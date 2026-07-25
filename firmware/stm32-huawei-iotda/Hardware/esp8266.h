#ifndef ESP8266_H
#define ESP8266_H

#include <stdint.h>

int ESP8266_InitAutoBaud(uint32_t preferredBaud, uint32_t *detectedBaud);
int ESP8266_JoinWiFi(const char *ssid, const char *password);
int ESP8266_OpenTCP(const char *host, uint16_t port);
void ESP8266_CloseTCP(void);
int ESP8266_SendTCP(const uint8_t *data,
                    uint16_t length,
                    uint8_t *response,
                    uint16_t responseCapacity,
                    uint16_t *responseLength,
                    uint32_t timeoutMs);
int ESP8266_ResponseHasMQTTConnack(const uint8_t *response,
                                   uint16_t length,
                                   uint8_t *returnCode);
int ESP8266_ResponseHasMQTTPingResp(const uint8_t *response, uint16_t length);
int ESP8266_WaitMQTTConnack(uint8_t *returnCode, uint32_t timeoutMs);
int ESP8266_WaitMQTTPingResp(uint32_t timeoutMs);

#endif

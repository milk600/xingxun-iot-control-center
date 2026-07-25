#ifndef SHA256_H
#define SHA256_H

#include <stdint.h>

typedef struct
{
    uint8_t data[64];
    uint32_t dataLength;
    uint32_t bitLengthHigh;
    uint32_t bitLengthLow;
    uint32_t state[8];
} SHA256_Context;

void SHA256_Init(SHA256_Context *context);
void SHA256_Update(SHA256_Context *context, const uint8_t *data, uint32_t length);
void SHA256_Final(SHA256_Context *context, uint8_t hash[32]);
void HMAC_SHA256_Hex(const uint8_t *key,
                     uint32_t keyLength,
                     const uint8_t *message,
                     uint32_t messageLength,
                     char outputHex[65]);

#endif

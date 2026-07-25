#include "sha256.h"
#include "util.h"

#define ROTRIGHT(value, bits) (((value) >> (bits)) | ((value) << (32U - (bits))))
#define CH(x, y, z)           (((x) & (y)) ^ (~(x) & (z)))
#define MAJ(x, y, z)          (((x) & (y)) ^ ((x) & (z)) ^ ((y) & (z)))
#define EP0(x)                (ROTRIGHT((x), 2U) ^ ROTRIGHT((x), 13U) ^ ROTRIGHT((x), 22U))
#define EP1(x)                (ROTRIGHT((x), 6U) ^ ROTRIGHT((x), 11U) ^ ROTRIGHT((x), 25U))
#define SIG0(x)               (ROTRIGHT((x), 7U) ^ ROTRIGHT((x), 18U) ^ ((x) >> 3U))
#define SIG1(x)               (ROTRIGHT((x), 17U) ^ ROTRIGHT((x), 19U) ^ ((x) >> 10U))

static const uint32_t kTable[64] = {
    0x428A2F98UL, 0x71374491UL, 0xB5C0FBCFUL, 0xE9B5DBA5UL,
    0x3956C25BUL, 0x59F111F1UL, 0x923F82A4UL, 0xAB1C5ED5UL,
    0xD807AA98UL, 0x12835B01UL, 0x243185BEUL, 0x550C7DC3UL,
    0x72BE5D74UL, 0x80DEB1FEUL, 0x9BDC06A7UL, 0xC19BF174UL,
    0xE49B69C1UL, 0xEFBE4786UL, 0x0FC19DC6UL, 0x240CA1CCUL,
    0x2DE92C6FUL, 0x4A7484AAUL, 0x5CB0A9DCUL, 0x76F988DAUL,
    0x983E5152UL, 0xA831C66DUL, 0xB00327C8UL, 0xBF597FC7UL,
    0xC6E00BF3UL, 0xD5A79147UL, 0x06CA6351UL, 0x14292967UL,
    0x27B70A85UL, 0x2E1B2138UL, 0x4D2C6DFCUL, 0x53380D13UL,
    0x650A7354UL, 0x766A0ABBUL, 0x81C2C92EUL, 0x92722C85UL,
    0xA2BFE8A1UL, 0xA81A664BUL, 0xC24B8B70UL, 0xC76C51A3UL,
    0xD192E819UL, 0xD6990624UL, 0xF40E3585UL, 0x106AA070UL,
    0x19A4C116UL, 0x1E376C08UL, 0x2748774CUL, 0x34B0BCB5UL,
    0x391C0CB3UL, 0x4ED8AA4AUL, 0x5B9CCA4FUL, 0x682E6FF3UL,
    0x748F82EEUL, 0x78A5636FUL, 0x84C87814UL, 0x8CC70208UL,
    0x90BEFFFAUL, 0xA4506CEBUL, 0xBEF9A3F7UL, 0xC67178F2UL
};

static void SHA256_Transform(SHA256_Context *context, const uint8_t data[64])
{
    uint32_t a;
    uint32_t b;
    uint32_t c;
    uint32_t d;
    uint32_t e;
    uint32_t f;
    uint32_t g;
    uint32_t h;
    uint32_t i;
    uint32_t j;
    uint32_t t1;
    uint32_t t2;
    uint32_t words[64];

    for (i = 0U, j = 0U; i < 16U; i++, j += 4U)
    {
        words[i] = ((uint32_t)data[j] << 24U) |
                   ((uint32_t)data[j + 1U] << 16U) |
                   ((uint32_t)data[j + 2U] << 8U) |
                   ((uint32_t)data[j + 3U]);
    }
    for (; i < 64U; i++)
    {
        words[i] = SIG1(words[i - 2U]) + words[i - 7U] +
                   SIG0(words[i - 15U]) + words[i - 16U];
    }

    a = context->state[0];
    b = context->state[1];
    c = context->state[2];
    d = context->state[3];
    e = context->state[4];
    f = context->state[5];
    g = context->state[6];
    h = context->state[7];

    for (i = 0U; i < 64U; i++)
    {
        t1 = h + EP1(e) + CH(e, f, g) + kTable[i] + words[i];
        t2 = EP0(a) + MAJ(a, b, c);
        h = g;
        g = f;
        f = e;
        e = d + t1;
        d = c;
        c = b;
        b = a;
        a = t1 + t2;
    }

    context->state[0] += a;
    context->state[1] += b;
    context->state[2] += c;
    context->state[3] += d;
    context->state[4] += e;
    context->state[5] += f;
    context->state[6] += g;
    context->state[7] += h;
}

void SHA256_Init(SHA256_Context *context)
{
    context->dataLength = 0U;
    context->bitLengthHigh = 0U;
    context->bitLengthLow = 0U;
    context->state[0] = 0x6A09E667UL;
    context->state[1] = 0xBB67AE85UL;
    context->state[2] = 0x3C6EF372UL;
    context->state[3] = 0xA54FF53AUL;
    context->state[4] = 0x510E527FUL;
    context->state[5] = 0x9B05688CUL;
    context->state[6] = 0x1F83D9ABUL;
    context->state[7] = 0x5BE0CD19UL;
}

void SHA256_Update(SHA256_Context *context, const uint8_t *data, uint32_t length)
{
    uint32_t index;
    uint32_t oldLow;

    for (index = 0U; index < length; index++)
    {
        context->data[context->dataLength] = data[index];
        context->dataLength++;
        if (context->dataLength == 64U)
        {
            SHA256_Transform(context, context->data);
            oldLow = context->bitLengthLow;
            context->bitLengthLow += 512U;
            if (context->bitLengthLow < oldLow)
            {
                context->bitLengthHigh++;
            }
            context->dataLength = 0U;
        }
    }
}

void SHA256_Final(SHA256_Context *context, uint8_t hash[32])
{
    uint32_t index;
    uint32_t bitLengthLow;
    uint32_t bitLengthHigh;

    index = context->dataLength;
    context->data[index++] = 0x80U;

    if (index > 56U)
    {
        while (index < 64U)
        {
            context->data[index++] = 0U;
        }
        SHA256_Transform(context, context->data);
        index = 0U;
    }

    while (index < 56U)
    {
        context->data[index++] = 0U;
    }

    bitLengthLow = context->bitLengthLow + (context->dataLength * 8U);
    bitLengthHigh = context->bitLengthHigh;
    if (bitLengthLow < context->bitLengthLow)
    {
        bitLengthHigh++;
    }

    context->data[63] = (uint8_t)(bitLengthLow);
    context->data[62] = (uint8_t)(bitLengthLow >> 8U);
    context->data[61] = (uint8_t)(bitLengthLow >> 16U);
    context->data[60] = (uint8_t)(bitLengthLow >> 24U);
    context->data[59] = (uint8_t)(bitLengthHigh);
    context->data[58] = (uint8_t)(bitLengthHigh >> 8U);
    context->data[57] = (uint8_t)(bitLengthHigh >> 16U);
    context->data[56] = (uint8_t)(bitLengthHigh >> 24U);
    SHA256_Transform(context, context->data);

    for (index = 0U; index < 4U; index++)
    {
        hash[index]       = (uint8_t)(context->state[0] >> (24U - index * 8U));
        hash[index + 4U]  = (uint8_t)(context->state[1] >> (24U - index * 8U));
        hash[index + 8U]  = (uint8_t)(context->state[2] >> (24U - index * 8U));
        hash[index + 12U] = (uint8_t)(context->state[3] >> (24U - index * 8U));
        hash[index + 16U] = (uint8_t)(context->state[4] >> (24U - index * 8U));
        hash[index + 20U] = (uint8_t)(context->state[5] >> (24U - index * 8U));
        hash[index + 24U] = (uint8_t)(context->state[6] >> (24U - index * 8U));
        hash[index + 28U] = (uint8_t)(context->state[7] >> (24U - index * 8U));
    }
}

void HMAC_SHA256_Hex(const uint8_t *key,
                     uint32_t keyLength,
                     const uint8_t *message,
                     uint32_t messageLength,
                     char outputHex[65])
{
    uint8_t keyBlock[64];
    uint8_t innerPad[64];
    uint8_t outerPad[64];
    uint8_t innerHash[32];
    uint8_t finalHash[32];
    uint8_t keyHash[32];
    uint32_t index;
    SHA256_Context context;
    static const char hexDigits[] = "0123456789abcdef";

    Util_MemSet(keyBlock, 0, sizeof(keyBlock));
    if (keyLength > 64U)
    {
        SHA256_Init(&context);
        SHA256_Update(&context, key, keyLength);
        SHA256_Final(&context, keyHash);
        Util_MemCopy(keyBlock, keyHash, 32U);
    }
    else
    {
        Util_MemCopy(keyBlock, key, keyLength);
    }

    for (index = 0U; index < 64U; index++)
    {
        innerPad[index] = (uint8_t)(keyBlock[index] ^ 0x36U);
        outerPad[index] = (uint8_t)(keyBlock[index] ^ 0x5CU);
    }

    SHA256_Init(&context);
    SHA256_Update(&context, innerPad, 64U);
    SHA256_Update(&context, message, messageLength);
    SHA256_Final(&context, innerHash);

    SHA256_Init(&context);
    SHA256_Update(&context, outerPad, 64U);
    SHA256_Update(&context, innerHash, 32U);
    SHA256_Final(&context, finalHash);

    for (index = 0U; index < 32U; index++)
    {
        outputHex[index * 2U] = hexDigits[(finalHash[index] >> 4U) & 0x0FU];
        outputHex[index * 2U + 1U] = hexDigits[finalHash[index] & 0x0FU];
    }
    outputHex[64] = '\0';
}

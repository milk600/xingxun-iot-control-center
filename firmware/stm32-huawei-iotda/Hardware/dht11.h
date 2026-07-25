#ifndef DHT11_H
#define DHT11_H

#include <stdint.h>

typedef struct
{
    int16_t temperature;
    uint8_t humidity;
    uint8_t temperatureDecimal;
    uint8_t humidityDecimal;
} DHT11_Data;

typedef enum
{
    DHT11_OK = 0,
    DHT11_ERROR_ARGUMENT = 1,
    DHT11_ERROR_RESPONSE_LOW = 2,
    DHT11_ERROR_RESPONSE_HIGH = 3,
    DHT11_ERROR_DATA_TIMEOUT = 4,
    DHT11_ERROR_CHECKSUM = 5
} DHT11_Status;

void DHT11_Init(void);
DHT11_Status DHT11_Read(DHT11_Data *data);

#endif

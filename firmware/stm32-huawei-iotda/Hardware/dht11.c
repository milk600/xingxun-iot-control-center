#include "dht11.h"
#include "delay.h"
#include "stm32f103x8.h"

#define DHT11_PIN 5U

static void DHT11_SetPinConfig(uint8_t config)
{
    uint32_t shift = DHT11_PIN * 4U;
    uint32_t value = GPIOB->CRL;
    value &= ~(0xFUL << shift);
    value |= ((uint32_t)config << shift);
    GPIOB->CRL = value;
}

static void DHT11_OutputOpenDrain(void)
{
    DHT11_SetPinConfig(0x07U); /* 50 MHz open-drain output. */
}

static void DHT11_InputPullUp(void)
{
    GPIOB->BSRR = (1UL << DHT11_PIN);
    DHT11_SetPinConfig(0x08U); /* Input with pull-up. */
}

static void DHT11_Write(uint8_t high)
{
    if (high != 0U)
    {
        GPIOB->BSRR = (1UL << DHT11_PIN);
    }
    else
    {
        GPIOB->BRR = (1UL << DHT11_PIN);
    }
}

static uint8_t DHT11_ReadPin(void)
{
    return ((GPIOB->IDR & (1UL << DHT11_PIN)) != 0U) ? 1U : 0U;
}

static int DHT11_WaitLevel(uint8_t level, uint32_t timeoutUs)
{
    uint32_t start = Delay_MicroTimer();
    while (DHT11_ReadPin() != level)
    {
        if ((uint32_t)(Delay_MicroTimer() - start) >= timeoutUs)
        {
            return 0;
        }
    }
    return 1;
}

void DHT11_Init(void)
{
    RCC->APB2ENR |= RCC_APB2ENR_IOPBEN;
    DHT11_OutputOpenDrain();
    DHT11_Write(1U);
}

DHT11_Status DHT11_Read(DHT11_Data *data)
{
    uint8_t bytes[5] = {0U, 0U, 0U, 0U, 0U};
    uint8_t bitIndex;
    uint8_t byteIndex;
    uint32_t highStart;
    uint32_t highTime;
    uint8_t checksum;

    if (data == 0)
    {
        return DHT11_ERROR_ARGUMENT;
    }

    DHT11_OutputOpenDrain();
    DHT11_Write(0U);
    Delay_ms(20U);
    DHT11_Write(1U);
    Delay_us(30U);
    DHT11_InputPullUp();

    if (!DHT11_WaitLevel(0U, 150U))
    {
        return DHT11_ERROR_RESPONSE_LOW;
    }
    if (!DHT11_WaitLevel(1U, 150U))
    {
        return DHT11_ERROR_RESPONSE_HIGH;
    }
    if (!DHT11_WaitLevel(0U, 150U))
    {
        return DHT11_ERROR_DATA_TIMEOUT;
    }

    for (bitIndex = 0U; bitIndex < 40U; bitIndex++)
    {
        if (!DHT11_WaitLevel(1U, 100U))
        {
            return DHT11_ERROR_DATA_TIMEOUT;
        }
        highStart = Delay_MicroTimer();
        while (DHT11_ReadPin() != 0U)
        {
            if ((uint32_t)(Delay_MicroTimer() - highStart) > 120U)
            {
                return DHT11_ERROR_DATA_TIMEOUT;
            }
        }
        highTime = (uint32_t)(Delay_MicroTimer() - highStart);

        byteIndex = (uint8_t)(bitIndex / 8U);
        bytes[byteIndex] <<= 1U;
        if (highTime > 40U)
        {
            bytes[byteIndex] |= 1U;
        }
    }

    checksum = (uint8_t)(bytes[0] + bytes[1] + bytes[2] + bytes[3]);
    if (checksum != bytes[4])
    {
        return DHT11_ERROR_CHECKSUM;
    }

    data->humidity = bytes[0];
    data->humidityDecimal = bytes[1];
    data->temperatureDecimal = bytes[3];
    if ((bytes[2] & 0x80U) != 0U)
    {
        data->temperature = -(int16_t)(bytes[2] & 0x7FU);
    }
    else
    {
        data->temperature = (int16_t)bytes[2];
    }
    return DHT11_OK;
}

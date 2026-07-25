#include "light_sensor.h"
#include "delay.h"
#include "stm32f103x8.h"

static uint8_t g_lightSensorReady = 0U;

static int WaitBitClear(volatile uint32_t *reg, uint32_t mask, uint32_t timeoutUs)
{
    uint32_t start = Delay_MicroTimer();

    while ((*reg & mask) != 0U)
    {
        if ((uint32_t)(Delay_MicroTimer() - start) >= timeoutUs)
        {
            return 0;
        }
    }
    return 1;
}

int LightSensor_Init(void)
{
    uint32_t value;

    g_lightSensorReady = 0U;

    RCC->APB2ENR |= RCC_APB2ENR_IOPAEN | RCC_APB2ENR_ADC1EN;

    /* PA1 = ADC1_IN1, analog input. */
    value = GPIOA->CRL;
    value &= ~(0xFUL << 4U);
    GPIOA->CRL = value;

    /* ADC clock = PCLK2 / 6 = 1.333 MHz with the 8 MHz HSI clock. */
    RCC->CFGR = (RCC->CFGR & ~RCC_CFGR_ADCPRE_MASK) | RCC_CFGR_ADCPRE_DIV6;

    ADC1->CR1 = 0U;
    ADC1->CR2 = ADC_CR2_EXTSEL_SWSTART | ADC_CR2_EXTTRIG;
    ADC1->SMPR2 &= ~(7UL << 3U);
    ADC1->SMPR2 |= (7UL << 3U); /* Channel 1, 239.5 ADC cycles. */
    ADC1->SQR1 = 0U;
    ADC1->SQR2 = 0U;
    ADC1->SQR3 = 1U;

    ADC1->CR2 |= ADC_CR2_ADON;
    Delay_us(30U);

    ADC1->CR2 |= ADC_CR2_RSTCAL;
    if (!WaitBitClear(&ADC1->CR2, ADC_CR2_RSTCAL, 2000U))
    {
        return 0;
    }

    ADC1->CR2 |= ADC_CR2_CAL;
    if (!WaitBitClear(&ADC1->CR2, ADC_CR2_CAL, 5000U))
    {
        return 0;
    }

    g_lightSensorReady = 1U;
    return 1;
}

uint8_t LightSensor_IsReady(void)
{
    return g_lightSensorReady;
}

static uint16_t LightSensor_ReadOnce(void)
{
    uint32_t start;

    if (g_lightSensorReady == 0U)
    {
        return 0U;
    }

    ADC1->CR2 |= ADC_CR2_SWSTART;
    start = Delay_MicroTimer();
    while ((ADC1->SR & ADC_SR_EOC) == 0U)
    {
        if ((uint32_t)(Delay_MicroTimer() - start) >= 5000U)
        {
            g_lightSensorReady = 0U;
            return 0U;
        }
    }
    return (uint16_t)(ADC1->DR & 0x0FFFU);
}

uint16_t LightSensor_ReadRaw(void)
{
    uint8_t index;
    uint32_t sum = 0U;

    if (g_lightSensorReady == 0U)
    {
        return 0U;
    }

    for (index = 0U; index < 16U; index++)
    {
        sum += LightSensor_ReadOnce();
        if (g_lightSensorReady == 0U)
        {
            return 0U;
        }
        Delay_us(100U);
    }
    return (uint16_t)(sum / 16U);
}

uint8_t LightSensor_ToPercent(uint16_t rawValue, uint8_t invert)
{
    uint32_t percent = ((uint32_t)rawValue * 100U + 2047U) / 4095U;
    if (percent > 100U)
    {
        percent = 100U;
    }
    if (invert != 0U)
    {
        percent = 100U - percent;
    }
    return (uint8_t)percent;
}

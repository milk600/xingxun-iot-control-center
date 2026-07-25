#include "delay.h"
#include "stm32f103x8.h"

static volatile uint32_t g_millis = 0U;

void SysTick_Handler(void)
{
    g_millis++;
}

void Delay_Init(void)
{
    uint32_t timerClock;

    SysTick->LOAD = (SystemCoreClock / 1000U) - 1U;
    SysTick->VAL = 0U;
    SysTick->CTRL = SYSTICK_CTRL_CLKSOURCE |
                    SYSTICK_CTRL_TICKINT |
                    SYSTICK_CTRL_ENABLE;

    RCC->APB1ENR |= RCC_APB1ENR_TIM2EN;
    timerClock = System_GetTIM2Clock();
    TIM2->CR1 = 0U;
    TIM2->PSC = (timerClock / 1000000U) - 1U;
    TIM2->ARR = 0xFFFFFFFFUL;
    TIM2->EGR = TIM_EGR_UG;
    TIM2->CNT = 0U;
    TIM2->CR1 = TIM_CR1_CEN;
}

uint32_t Millis(void)
{
    return g_millis;
}

uint32_t Delay_MicroTimer(void)
{
    return TIM2->CNT;
}

void Delay_ms(uint32_t milliseconds)
{
    uint32_t start = Millis();
    while ((uint32_t)(Millis() - start) < milliseconds)
    {
    }
}

void Delay_us(uint32_t microseconds)
{
    uint32_t start = TIM2->CNT;
    while ((uint32_t)(TIM2->CNT - start) < microseconds)
    {
    }
}

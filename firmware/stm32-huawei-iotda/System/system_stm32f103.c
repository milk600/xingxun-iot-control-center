#include "stm32f103x8.h"

/*
 * Reliability-first clock configuration:
 * use the internal 8 MHz HSI clock. This avoids a startup failure when the
 * external crystal, soldering, or board configuration differs.
 */
uint32_t SystemCoreClock = 8000000UL;

void SystemInit(void)
{
    RCC->CR |= RCC_CR_HSION;
    while ((RCC->CR & RCC_CR_HSIRDY) == 0U)
    {
    }

    RCC->CFGR &= ~RCC_CFGR_SW_MASK;
    RCC->CFGR |= RCC_CFGR_SW_HSI;
    while ((RCC->CFGR & RCC_CFGR_SWS_MASK) != RCC_CFGR_SWS_HSI)
    {
    }

    RCC->CR &= ~(RCC_CR_PLLON | RCC_CR_HSEON | RCC_CR_CSSON | RCC_CR_HSEBYP);
    RCC->CIR = 0U;
    FLASH->ACR = FLASH_ACR_LATENCY_0;
    SCB->VTOR = 0x08000000UL;
    SystemCoreClock = 8000000UL;
}

uint32_t System_GetPCLK1(void)
{
    return 8000000UL;
}

uint32_t System_GetPCLK2(void)
{
    return 8000000UL;
}

uint32_t System_GetTIM2Clock(void)
{
    return 8000000UL;
}

#ifndef STM32F103X8_MIN_H
#define STM32F103X8_MIN_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define __IO volatile
#define __I  volatile const
#define __O  volatile

/* Minimal STM32F103C8 register definitions used by this project. */
typedef struct
{
    __IO uint32_t CR;
    __IO uint32_t CFGR;
    __IO uint32_t CIR;
    __IO uint32_t APB2RSTR;
    __IO uint32_t APB1RSTR;
    __IO uint32_t AHBENR;
    __IO uint32_t APB2ENR;
    __IO uint32_t APB1ENR;
    __IO uint32_t BDCR;
    __IO uint32_t CSR;
} RCC_TypeDef;

typedef struct
{
    __IO uint32_t ACR;
    __IO uint32_t KEYR;
    __IO uint32_t OPTKEYR;
    __IO uint32_t SR;
    __IO uint32_t CR;
    __IO uint32_t AR;
    __IO uint32_t RESERVED;
    __IO uint32_t OBR;
    __IO uint32_t WRPR;
} FLASH_TypeDef;

typedef struct
{
    __IO uint32_t EVCR;
    __IO uint32_t MAPR;
    __IO uint32_t EXTICR[4];
    uint32_t RESERVED0;
    __IO uint32_t MAPR2;
} AFIO_TypeDef;

typedef struct
{
    __IO uint32_t CRL;
    __IO uint32_t CRH;
    __IO uint32_t IDR;
    __IO uint32_t ODR;
    __IO uint32_t BSRR;
    __IO uint32_t BRR;
    __IO uint32_t LCKR;
} GPIO_TypeDef;

typedef struct
{
    __IO uint32_t SR;
    __IO uint32_t CR1;
    __IO uint32_t CR2;
    __IO uint32_t SMPR1;
    __IO uint32_t SMPR2;
    __IO uint32_t JOFR1;
    __IO uint32_t JOFR2;
    __IO uint32_t JOFR3;
    __IO uint32_t JOFR4;
    __IO uint32_t HTR;
    __IO uint32_t LTR;
    __IO uint32_t SQR1;
    __IO uint32_t SQR2;
    __IO uint32_t SQR3;
    __IO uint32_t JSQR;
    __IO uint32_t JDR1;
    __IO uint32_t JDR2;
    __IO uint32_t JDR3;
    __IO uint32_t JDR4;
    __IO uint32_t DR;
} ADC_TypeDef;

typedef struct
{
    __IO uint32_t CR1;
    __IO uint32_t CR2;
    __IO uint32_t SMCR;
    __IO uint32_t DIER;
    __IO uint32_t SR;
    __IO uint32_t EGR;
    __IO uint32_t CCMR1;
    __IO uint32_t CCMR2;
    __IO uint32_t CCER;
    __IO uint32_t CNT;
    __IO uint32_t PSC;
    __IO uint32_t ARR;
    __IO uint32_t RESERVED1;
    __IO uint32_t CCR1;
    __IO uint32_t CCR2;
    __IO uint32_t CCR3;
    __IO uint32_t CCR4;
    __IO uint32_t RESERVED2;
    __IO uint32_t DCR;
    __IO uint32_t DMAR;
} TIM_TypeDef;

typedef struct
{
    __IO uint32_t SR;
    __IO uint32_t DR;
    __IO uint32_t BRR;
    __IO uint32_t CR1;
    __IO uint32_t CR2;
    __IO uint32_t CR3;
    __IO uint32_t GTPR;
} USART_TypeDef;

typedef struct
{
    __IO uint32_t CTRL;
    __IO uint32_t LOAD;
    __IO uint32_t VAL;
    __I  uint32_t CALIB;
} SysTick_Type;

typedef struct
{
    __I  uint32_t CPUID;
    __IO uint32_t ICSR;
    __IO uint32_t VTOR;
    __IO uint32_t AIRCR;
    __IO uint32_t SCR;
    __IO uint32_t CCR;
    __IO uint8_t  SHP[12];
    __IO uint32_t SHCSR;
} SCB_Type;

#define PERIPH_BASE          (0x40000000UL)
#define APB1PERIPH_BASE      (PERIPH_BASE)
#define APB2PERIPH_BASE      (PERIPH_BASE + 0x00010000UL)
#define AHBPERIPH_BASE       (PERIPH_BASE + 0x00020000UL)

#define TIM2_BASE            (APB1PERIPH_BASE + 0x00000000UL)
#define USART2_BASE          (APB1PERIPH_BASE + 0x00004400UL)
#define USART3_BASE          (APB1PERIPH_BASE + 0x00004800UL)
#define AFIO_BASE            (APB2PERIPH_BASE + 0x00000000UL)
#define GPIOA_BASE           (APB2PERIPH_BASE + 0x00000800UL)
#define GPIOB_BASE           (APB2PERIPH_BASE + 0x00000C00UL)
#define GPIOC_BASE           (APB2PERIPH_BASE + 0x00001000UL)
#define ADC1_BASE            (APB2PERIPH_BASE + 0x00002400UL)
#define USART1_BASE          (APB2PERIPH_BASE + 0x00003800UL)
#define RCC_BASE             (AHBPERIPH_BASE  + 0x00001000UL)
#define FLASH_R_BASE         (AHBPERIPH_BASE  + 0x00002000UL)

#define TIM2                 ((TIM_TypeDef *)TIM2_BASE)
#define USART1               ((USART_TypeDef *)USART1_BASE)
#define USART2               ((USART_TypeDef *)USART2_BASE)
#define USART3               ((USART_TypeDef *)USART3_BASE)
#define AFIO                 ((AFIO_TypeDef *)AFIO_BASE)
#define GPIOA                ((GPIO_TypeDef *)GPIOA_BASE)
#define GPIOB                ((GPIO_TypeDef *)GPIOB_BASE)
#define GPIOC                ((GPIO_TypeDef *)GPIOC_BASE)
#define ADC1                 ((ADC_TypeDef *)ADC1_BASE)
#define RCC                  ((RCC_TypeDef *)RCC_BASE)
#define FLASH                ((FLASH_TypeDef *)FLASH_R_BASE)
#define SysTick              ((SysTick_Type *)0xE000E010UL)
#define SCB                  ((SCB_Type *)0xE000ED00UL)
#define NVIC_ISER            ((volatile uint32_t *)0xE000E100UL)
#define USART3_IRQn          39U
#define USART2_IRQn          38U

/* RCC CR bits. */
#define RCC_CR_HSION         (1UL << 0)
#define RCC_CR_HSIRDY        (1UL << 1)
#define RCC_CR_HSEON         (1UL << 16)
#define RCC_CR_HSERDY        (1UL << 17)
#define RCC_CR_HSEBYP        (1UL << 18)
#define RCC_CR_CSSON         (1UL << 19)
#define RCC_CR_PLLON         (1UL << 24)
#define RCC_CR_PLLRDY        (1UL << 25)

/* RCC CFGR bits. */
#define RCC_CFGR_SW_MASK     (3UL << 0)
#define RCC_CFGR_SW_HSI      (0UL << 0)
#define RCC_CFGR_SWS_MASK    (3UL << 2)
#define RCC_CFGR_SWS_HSI     (0UL << 2)
#define RCC_CFGR_ADCPRE_MASK (3UL << 14)
#define RCC_CFGR_ADCPRE_DIV6 (2UL << 14)

/* RCC peripheral clock enables. */
#define RCC_APB2ENR_AFIOEN   (1UL << 0)
#define RCC_APB2ENR_IOPAEN   (1UL << 2)
#define RCC_APB2ENR_IOPBEN   (1UL << 3)
#define RCC_APB2ENR_IOPCEN   (1UL << 4)
#define RCC_APB2ENR_ADC1EN   (1UL << 9)
#define RCC_APB2ENR_USART1EN (1UL << 14)
#define RCC_APB1ENR_TIM2EN   (1UL << 0)
#define RCC_APB1ENR_USART2EN (1UL << 17)
#define RCC_APB1ENR_USART3EN (1UL << 18)

/* FLASH. */
#define FLASH_ACR_LATENCY_MASK (7UL << 0)
#define FLASH_ACR_LATENCY_0    (0UL << 0)

/* USART. */
#define USART_SR_PE          (1UL << 0)
#define USART_SR_FE          (1UL << 1)
#define USART_SR_NE          (1UL << 2)
#define USART_SR_ORE         (1UL << 3)
#define USART_SR_IDLE        (1UL << 4)
#define USART_SR_RXNE        (1UL << 5)
#define USART_SR_TC          (1UL << 6)
#define USART_SR_TXE         (1UL << 7)
#define USART_CR1_RE         (1UL << 2)
#define USART_CR1_TE         (1UL << 3)
#define USART_CR1_RXNEIE     (1UL << 5)
#define USART_CR1_UE         (1UL << 13)

/* ADC. */
#define ADC_SR_EOC             (1UL << 1)
#define ADC_CR2_ADON           (1UL << 0)
#define ADC_CR2_CAL            (1UL << 2)
#define ADC_CR2_RSTCAL         (1UL << 3)
#define ADC_CR2_EXTSEL_SWSTART (7UL << 17)
#define ADC_CR2_EXTTRIG        (1UL << 20)
#define ADC_CR2_SWSTART        (1UL << 22)

/* TIM. */
#define TIM_CR1_CEN          (1UL << 0)
#define TIM_EGR_UG           (1UL << 0)

/* SysTick. */
#define SYSTICK_CTRL_ENABLE    (1UL << 0)
#define SYSTICK_CTRL_TICKINT   (1UL << 1)
#define SYSTICK_CTRL_CLKSOURCE (1UL << 2)

extern uint32_t SystemCoreClock;
void SystemInit(void);
uint32_t System_GetPCLK1(void);
uint32_t System_GetPCLK2(void);
uint32_t System_GetTIM2Clock(void);

#ifdef __cplusplus
}
#endif

#endif

#include "uart.h"
#include "delay.h"

#define ESP_RX_RING_SIZE 1024U
#define ESP_RX_RING_MASK (ESP_RX_RING_SIZE - 1U)

static uint8_t g_debugMirror = 0U;
static uint32_t g_espBaud = 0U;
static volatile uint8_t g_espRxRing[ESP_RX_RING_SIZE];
static volatile uint16_t g_espRxHead = 0U;
static volatile uint16_t g_espRxTail = 0U;
static volatile uint32_t g_espRxOverflow = 0U;

static void GPIO_SetConfig(GPIO_TypeDef *port, uint8_t pin, uint8_t config)
{
    uint32_t shift;
    uint32_t value;

    if (pin < 8U)
    {
        shift = (uint32_t)pin * 4U;
        value = port->CRL;
        value &= ~(0xFUL << shift);
        value |= ((uint32_t)config << shift);
        port->CRL = value;
    }
    else
    {
        shift = ((uint32_t)pin - 8U) * 4U;
        value = port->CRH;
        value &= ~(0xFUL << shift);
        value |= ((uint32_t)config << shift);
        port->CRH = value;
    }
}

static void UART_Configure(USART_TypeDef *uart, uint32_t peripheralClock, uint32_t baud)
{
    uint32_t divider;

    uart->CR1 = 0U;
    uart->CR2 = 0U;
    uart->CR3 = 0U;
    divider = (peripheralClock + (baud / 2U)) / baud;
    uart->BRR = divider;
    uart->CR1 = USART_CR1_UE | USART_CR1_TE | USART_CR1_RE;
}

static void ESP_RingReset(void)
{
    g_espRxHead = 0U;
    g_espRxTail = 0U;
    g_espRxOverflow = 0U;
}

static int ESP_RingRead(uint8_t *value)
{
    uint16_t tail = g_espRxTail;

    if (tail == g_espRxHead)
    {
        return 0;
    }

    *value = g_espRxRing[tail];
    g_espRxTail = (uint16_t)((tail + 1U) & ESP_RX_RING_MASK);
    return 1;
}

void USART3_IRQHandler(void)
{
    uint32_t status = USART3->SR;

    if ((status & (USART_SR_RXNE | USART_SR_ORE | USART_SR_FE |
                   USART_SR_NE | USART_SR_PE)) != 0U)
    {
        uint8_t value = (uint8_t)(USART3->DR & 0xFFU);

        if ((status & USART_SR_RXNE) != 0U)
        {
            uint16_t head = g_espRxHead;
            uint16_t next = (uint16_t)((head + 1U) & ESP_RX_RING_MASK);

            if (next == g_espRxTail)
            {
                /* Keep the newest data if a very long unsolicited message arrives. */
                g_espRxTail = (uint16_t)((g_espRxTail + 1U) & ESP_RX_RING_MASK);
                g_espRxOverflow++;
            }

            g_espRxRing[head] = value;
            g_espRxHead = next;
        }
    }
}

void UART_InitDebug(uint32_t baud, uint8_t mirrorToUsart2)
{
    RCC->APB2ENR |= RCC_APB2ENR_AFIOEN |
                    RCC_APB2ENR_IOPAEN |
                    RCC_APB2ENR_USART1EN;

    /* USART1: PA9 TX, PA10 RX. */
    GPIO_SetConfig(GPIOA, 9U, 0x0BU);
    GPIO_SetConfig(GPIOA, 10U, 0x04U);
    UART_Configure(USART1, System_GetPCLK2(), baud);

    g_debugMirror = (mirrorToUsart2 != 0U) ? 1U : 0U;
    if (g_debugMirror != 0U)
    {
        RCC->APB1ENR |= RCC_APB1ENR_USART2EN;
        /* Optional mirrored log: PA2 TX, PA3 RX. */
        GPIO_SetConfig(GPIOA, 2U, 0x0BU);
        GPIO_SetConfig(GPIOA, 3U, 0x04U);
        UART_Configure(USART2, System_GetPCLK1(), baud);
    }
}

/* -------------------------------------------------------------------------
 * JW01 气体传感器接收（USART2 硬件串口）
 *
 * JW01 模块上电后持续以 9600-8-N-1 广播 UART 帧，MCU 只读不写。
 * USART2 的 PA3（USART2_RX）作为接收脚，PA2（USART2_TX）闲置。
 * 注意：本工程中 USART1(PA9/PA10)=调试主输出、USART3(PB10/PB11)=ESP，
 *       因此 USART2(PA2/PA3) 被重新分配给 JW01 使用（需关闭调试镜像）。
 * ----------------------------------------------------------------------- */
#define JW01_RX_RING_SIZE 128U
#define JW01_RX_RING_MASK (JW01_RX_RING_SIZE - 1U)
static volatile uint8_t  g_jw01RxRing[JW01_RX_RING_SIZE];
static volatile uint16_t g_jw01RxHead = 0U;
static volatile uint16_t g_jw01RxTail = 0U;
static volatile uint32_t g_jw01RxOverflow = 0U;
static volatile uint32_t g_jw01RxTotal = 0U;

void USART2_IRQHandler(void)
{
    uint32_t status = USART2->SR;

    if ((status & (USART_SR_RXNE | USART_SR_ORE | USART_SR_FE |
                   USART_SR_NE | USART_SR_PE)) != 0U)
    {
        uint8_t value = (uint8_t)(USART2->DR & 0xFFU);

        if ((status & USART_SR_RXNE) != 0U)
        {
            uint16_t head = g_jw01RxHead;
            uint16_t next = (uint16_t)((head + 1U) & JW01_RX_RING_MASK);

            if (next == g_jw01RxTail)
            {
                /* Ring full: drop oldest byte so newest data survives. */
                g_jw01RxTail = (uint16_t)((g_jw01RxTail + 1U) & JW01_RX_RING_MASK);
                g_jw01RxOverflow++;
            }

            g_jw01RxRing[head] = value;
            g_jw01RxHead = next;
            g_jw01RxTotal++;
        }
    }
}

void UART_InitJW01(uint32_t baud)
{
    RCC->APB2ENR |= RCC_APB2ENR_AFIOEN | RCC_APB2ENR_IOPAEN;
    RCC->APB1ENR |= RCC_APB1ENR_USART2EN;

    /* PA2 = TX（AF 推挽，未使用），PA3 = RX（浮空输入，接 JW01 B 脚） */
    GPIO_SetConfig(GPIOA, 2U, 0x0BU);
    GPIO_SetConfig(GPIOA, 3U, 0x04U);

    g_jw01RxHead = 0U;
    g_jw01RxTail = 0U;
    g_jw01RxOverflow = 0U;
    g_jw01RxTotal = 0U;

    UART_Configure(USART2, System_GetPCLK1(), baud);
    USART2->CR1 |= USART_CR1_RXNEIE;
    NVIC_ISER[USART2_IRQn >> 5U] = (1UL << (USART2_IRQn & 0x1FU));
}

int UART_JW01RxReadTimeout(uint8_t *value, uint32_t timeoutMs)
{
    uint32_t start = Millis();

    for (;;)
    {
        if (g_jw01RxHead != g_jw01RxTail)
        {
            *value = g_jw01RxRing[g_jw01RxTail];
            g_jw01RxTail = (uint16_t)((g_jw01RxTail + 1U) & JW01_RX_RING_MASK);
            return 1;
        }
        if ((uint32_t)(Millis() - start) >= timeoutMs)
        {
            return 0;
        }
    }
}

uint32_t UART_JW01RxTotalCount(void)
{
    return g_jw01RxTotal;
}

uint32_t UART_JW01RxOverflowCount(void)
{
    return g_jw01RxOverflow;
}


void UART_InitEsp(uint32_t baud)
{
    RCC->APB2ENR |= RCC_APB2ENR_AFIOEN | RCC_APB2ENR_IOPBEN;
    RCC->APB1ENR |= RCC_APB1ENR_USART3EN;

    /* USART3: PB10 TX to ESP RX, PB11 RX from ESP TX. */
    GPIO_SetConfig(GPIOB, 10U, 0x0BU);
    GPIO_SetConfig(GPIOB, 11U, 0x04U);

    ESP_RingReset();
    UART_Configure(USART3, System_GetPCLK1(), baud);
    USART3->CR1 |= USART_CR1_RXNEIE;
    NVIC_ISER[USART3_IRQn >> 5U] = (1UL << (USART3_IRQn & 0x1FU));
    g_espBaud = baud;
}

void UART_SetEspBaud(uint32_t baud)
{
    USART3->CR1 &= ~USART_CR1_RXNEIE;
    ESP_RingReset();
    UART_Configure(USART3, System_GetPCLK1(), baud);
    USART3->CR1 |= USART_CR1_RXNEIE;
    NVIC_ISER[USART3_IRQn >> 5U] = (1UL << (USART3_IRQn & 0x1FU));
    g_espBaud = baud;
}

uint32_t UART_GetEspBaud(void)
{
    return g_espBaud;
}

uint8_t UART_DebugMirrorEnabled(void)
{
    return g_debugMirror;
}

uint32_t UART_EspRxOverflowCount(void)
{
    return g_espRxOverflow;
}

void UART_WriteByte(USART_TypeDef *uart, uint8_t value)
{
    while ((uart->SR & USART_SR_TXE) == 0U)
    {
    }
    uart->DR = value;
}

void UART_Write(USART_TypeDef *uart, const uint8_t *data, uint16_t length)
{
    uint16_t index;

    for (index = 0U; index < length; index++)
    {
        UART_WriteByte(uart, data[index]);
    }
    while ((uart->SR & USART_SR_TC) == 0U)
    {
    }
}

void UART_WriteString(USART_TypeDef *uart, const char *text)
{
    while ((text != 0) && (*text != '\0'))
    {
        UART_WriteByte(uart, (uint8_t)*text++);
    }
    while ((uart->SR & USART_SR_TC) == 0U)
    {
    }
}

int UART_ReadByteTimeout(USART_TypeDef *uart, uint8_t *value, uint32_t timeoutMs)
{
    uint32_t start = Millis();
    uint32_t status;

    if (uart == USART3)
    {
        for (;;)
        {
            if (ESP_RingRead(value))
            {
                return 1;
            }
            if ((uint32_t)(Millis() - start) >= timeoutMs)
            {
                return 0;
            }
        }
    }

    for (;;)
    {
        status = uart->SR;
        if ((status & USART_SR_RXNE) != 0U)
        {
            *value = (uint8_t)(uart->DR & 0xFFU);
            return 1;
        }

        if ((status & (USART_SR_ORE | USART_SR_FE | USART_SR_NE | USART_SR_PE)) != 0U)
        {
            volatile uint32_t dummy = uart->DR;
            (void)dummy;
        }

        if ((uint32_t)(Millis() - start) >= timeoutMs)
        {
            return 0;
        }
    }
}

void UART_FlushRx(USART_TypeDef *uart)
{
    volatile uint32_t status;
    volatile uint32_t data;

    if (uart == USART3)
    {
        USART3->CR1 &= ~USART_CR1_RXNEIE;
        ESP_RingReset();
        do
        {
            status = USART3->SR;
            data = USART3->DR;
            (void)data;
        } while ((status & (USART_SR_RXNE | USART_SR_ORE | USART_SR_FE |
                           USART_SR_NE | USART_SR_PE)) != 0U);
        USART3->CR1 |= USART_CR1_RXNEIE;
        return;
    }

    do
    {
        status = uart->SR;
        data = uart->DR;
        (void)data;
    } while ((status & (USART_SR_RXNE | USART_SR_ORE | USART_SR_FE |
                       USART_SR_NE | USART_SR_PE)) != 0U);
}

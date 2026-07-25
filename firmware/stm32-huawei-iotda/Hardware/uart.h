#ifndef UART_H
#define UART_H

#include <stdint.h>
#include "stm32f103x8.h"

void UART_InitDebug(uint32_t baud, uint8_t mirrorToUsart2);
void UART_InitJW01(uint32_t baud);
int  UART_JW01RxReadTimeout(uint8_t *value, uint32_t timeoutMs);
uint32_t UART_JW01RxTotalCount(void);
uint32_t UART_JW01RxOverflowCount(void);
void UART_InitEsp(uint32_t baud);
void UART_SetEspBaud(uint32_t baud);
uint32_t UART_GetEspBaud(void);
uint32_t UART_EspRxOverflowCount(void);
void UART_WriteByte(USART_TypeDef *uart, uint8_t value);
void UART_Write(USART_TypeDef *uart, const uint8_t *data, uint16_t length);
void UART_WriteString(USART_TypeDef *uart, const char *text);
int UART_ReadByteTimeout(USART_TypeDef *uart, uint8_t *value, uint32_t timeoutMs);
void UART_FlushRx(USART_TypeDef *uart);
uint8_t UART_DebugMirrorEnabled(void);

#define ESP_UART USART3

void USART3_IRQHandler(void);
void USART2_IRQHandler(void);

#endif

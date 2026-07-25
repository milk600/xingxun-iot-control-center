#ifndef DELAY_H
#define DELAY_H

#include <stdint.h>

void Delay_Init(void);
void Delay_ms(uint32_t milliseconds);
void Delay_us(uint32_t microseconds);
uint32_t Millis(void);
uint32_t Delay_MicroTimer(void);

#endif

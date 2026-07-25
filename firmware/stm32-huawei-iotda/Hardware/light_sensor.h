#ifndef LIGHT_SENSOR_H
#define LIGHT_SENSOR_H

#include <stdint.h>

/* Returns 1 when ADC initialization/calibration succeeds, otherwise 0. */
int LightSensor_Init(void);
uint8_t LightSensor_IsReady(void);
uint16_t LightSensor_ReadRaw(void);
uint8_t LightSensor_ToPercent(uint16_t rawValue, uint8_t invert);

#endif

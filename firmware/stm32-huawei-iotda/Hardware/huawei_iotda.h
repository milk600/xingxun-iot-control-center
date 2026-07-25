#ifndef HUAWEI_IOTDA_H
#define HUAWEI_IOTDA_H

#include <stdint.h>

int HuaweiIoTDA_ConfigLooksValid(void);
int HuaweiIoTDA_Connect(void);
int HuaweiIoTDA_Report(int temperature,
                       int humidity,
                       uint16_t lightRaw,
                       uint8_t lightPercent,
                       uint16_t tvoc,
                       uint16_t ch2o,
                       uint16_t co2);
int HuaweiIoTDA_Ping(void);
void HuaweiIoTDA_Disconnect(void);
uint8_t HuaweiIoTDA_IsConnected(void);
uint8_t HuaweiIoTDA_LastConnackCode(void);

#endif

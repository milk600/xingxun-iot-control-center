#include "app_config.h"
#include "debug.h"
#include "delay.h"
#include "dht11.h"
#include "esp8266.h"
#include "huawei_iotda.h"
#include "jwsensor.h"
#include "light_sensor.h"
#include "stm32f103x8.h"

static uint8_t g_espReady = 0U;
static uint8_t g_wifiReady = 0U;

static void PrintBanner(void)
{
    Debug_PrintLine("");
    Debug_PrintLine("============================================================");
    Debug_PrintLine("STM32F103C8 + DHT11 + Light + JW01 VOC + ESP-12F + Huawei IoTDA");
    Debug_PrintLine("DHT11=PB5, Light ADC=PA1, JW01 VOC=PA3(USART2 RX), ESP USART3=PB10/PB11");
    Debug_PrintLine("Debug USART1=PA9/PA10; mirror USART2=PA2/PA3");
    Debug_Print("SystemCoreClock=");
    Debug_PrintUInt(SystemCoreClock);
    Debug_PrintLine(" Hz");
    Debug_PrintLine("============================================================");
}

static int ConnectNetworkAndCloud(void)
{
    uint32_t detectedBaud = 0U;

    if (g_espReady == 0U)
    {
        Debug_PrintLine("[1/3] Detecting ESP-12F AT firmware...");
        if (!ESP8266_InitAutoBaud(ESP_UART_BAUD, &detectedBaud))
        {
            Debug_PrintLine("[FAIL] ESP did not answer AT on PB10/PB11.");
            return 0;
        }
        g_espReady = 1U;
        Debug_Print("[OK] ESP AT baud = ");
        Debug_PrintUInt(detectedBaud);
        Debug_PrintLine("");
    }

    if (g_wifiReady == 0U)
    {
        Debug_Print("[2/3] Connecting Wi-Fi SSID: ");
        Debug_PrintLine(WIFI_SSID);
        if (!ESP8266_JoinWiFi(WIFI_SSID, WIFI_PASSWORD))
        {
            Debug_PrintLine("[FAIL] Wi-Fi connection failed.");
            g_espReady = 0U;
            return 0;
        }
        g_wifiReady = 1U;
        Debug_PrintLine("[OK] Wi-Fi connected.");
    }

#if CLOUD_UPLOAD_ENABLE
    Debug_PrintLine("[3/3] Connecting Huawei Cloud IoTDA MQTT...");
    if (!HuaweiIoTDA_Connect())
    {
        Debug_Print("[FAIL] IoTDA MQTT connection failed. CONNACK=0x");
        Debug_PrintHexByte(HuaweiIoTDA_LastConnackCode());
        Debug_PrintLine("");
        return 0;
    }
    Debug_PrintLine("[OK] Huawei IoTDA connected; device should be online.");
#endif
    return 1;
}

static int ReadDHTWithRetry(DHT11_Data *data)
{
    DHT11_Status status;
    uint8_t attempt;

    for (attempt = 0U; attempt < 2U; attempt++)
    {
        status = DHT11_Read(data);
        if (status == DHT11_OK)
        {
            return 1;
        }
        Debug_Print("[WARN] DHT11 read failed, code=");
        Debug_PrintUInt((uint32_t)status);
        Debug_PrintLine("");
        if (attempt == 0U)
        {
            Delay_ms(1200U);
        }
    }
    return 0;
}

int main(void)
{
    DHT11_Data sensor;
    JWSensor_Data voc;
    uint16_t lightRaw;
    uint8_t lightPercent;
    uint32_t lastReport;
    uint32_t lastPing;
    uint32_t lastReconnect;
    uint8_t haveDht = 0U;
    uint8_t haveVoc = 0U;

    Delay_Init();
    Debug_Init(DEBUG_UART_BAUD, DEBUG_MIRROR_USART2);

    /* Print immediately, before any sensor/cloud initialization can block. */
    PrintBanner();
    Debug_PrintLine("[BOOT] Debug UART is alive.");

    DHT11_Init();
    Debug_PrintLine("[BOOT] DHT11 GPIO initialized.");

    if (LightSensor_Init())
    {
        Debug_PrintLine("[BOOT] ADC1/PA1 initialized.");
    }
    else
    {
        Debug_PrintLine("[WARN] ADC1 calibration timeout; light reading disabled.");
    }

    JWSensor_Init();
    Debug_PrintLine("[BOOT] JW01 VOC sensor (PA3 / USART2 RX, hardware UART @9600) initialized.");
    {
        uint32_t rxTotal = JWSensor_RxTotal();
        uint32_t rxOver  = JWSensor_RxOverflow();
        Debug_Print("[BOOT] JW01 USART2 RX since boot: total=");
        Debug_PrintUInt(rxTotal);
        Debug_Print(", overflow=");
        Debug_PrintUInt(rxOver);
        Debug_PrintLine("  [total>0=PA3 received bytes; total=0=no signal on PA3 (check wire/B->PA3)]");
    }

    if (!HuaweiIoTDA_ConfigLooksValid())
    {
        Debug_PrintLine("[FATAL] app_config.h is incomplete.");
    }

    lastReport = Millis() - SENSOR_UPLOAD_PERIOD_MS;
    lastPing = Millis();
    lastReconnect = Millis() - RECONNECT_PERIOD_MS;

    while (1)
    {
#if CLOUD_UPLOAD_ENABLE
        if ((HuaweiIoTDA_IsConnected() == 0U) &&
            ((uint32_t)(Millis() - lastReconnect) >= RECONNECT_PERIOD_MS))
        {
            lastReconnect = Millis();
            if (!ConnectNetworkAndCloud())
            {
                /* Re-run Wi-Fi join next time in case the AP connection was lost. */
                g_wifiReady = 0U;
                HuaweiIoTDA_Disconnect();
            }
            else
            {
                lastPing = Millis();
            }
        }
#endif

        if ((uint32_t)(Millis() - lastReport) >= SENSOR_UPLOAD_PERIOD_MS)
        {
            lastReport = Millis();
            haveDht = (uint8_t)ReadDHTWithRetry(&sensor);
            haveVoc = JWSensor_ReadFrame(&voc);
            if (haveVoc == 0U)
            {
                Debug_Print("[JW] read failed, err=");
                Debug_PrintUInt((uint32_t)JWSensor_LastError);
                Debug_Print("; USART2 RX total=");
                Debug_PrintUInt(JWSensor_RxTotal());
                Debug_Print(", overflow=");
                Debug_PrintUInt(JWSensor_RxOverflow());
                Debug_PrintLine("  [err=1:no signal on PA3; err=2:got bytes but no 0x2C header; err=3:checksum fail]");
            }
            if (LightSensor_IsReady() != 0U)
            {
                lightRaw = LightSensor_ReadRaw();
                lightPercent = LightSensor_ToPercent(lightRaw, LIGHT_SENSOR_INVERT);
            }
            else
            {
                lightRaw = 0U;
                lightPercent = 0U;
            }

            Debug_Print("[SENSOR] T=");
            if (haveDht != 0U)
            {
                Debug_PrintInt(sensor.temperature);
            }
            else
            {
                Debug_Print("N/A");
            }
            Debug_Print(" C, H=");
            if (haveDht != 0U)
            {
                Debug_PrintUInt(sensor.humidity);
            }
            else
            {
                Debug_Print("N/A");
            }
            Debug_Print(" %, LightRaw=");
            Debug_PrintUInt(lightRaw);
            Debug_Print(", Light=");
            Debug_PrintUInt(lightPercent);
            Debug_Print(" %, TVOC=");
            if (haveVoc != 0U)
            {
                Debug_PrintFloat3(voc.tvoc);
            }
            else
            {
                Debug_Print("N/A");
            }
            Debug_Print(" mg/m3, CH2O=");
            if (haveVoc != 0U)
            {
                Debug_PrintFloat3(voc.ch2o);
            }
            else
            {
                Debug_Print("N/A");
            }
            Debug_Print(" mg/m3, CO2=");
            if (haveVoc != 0U)
            {
                Debug_PrintUInt(voc.co2);
            }
            else
            {
                Debug_Print("N/A");
            }
            Debug_PrintLine(" ppm");

#if CLOUD_UPLOAD_ENABLE
            if (HuaweiIoTDA_IsConnected() != 0U)
            {
                if (HuaweiIoTDA_Report(sensor.temperature,
                                       sensor.humidity,
                                       lightRaw,
                                       lightPercent,
                                       haveVoc ? voc.tvoc : 0U,
                                       haveVoc ? voc.ch2o : 0U,
                                       haveVoc ? voc.co2 : 0U))
                {
                    Debug_PrintLine("[CLOUD] Property report OK.");
                    lastPing = Millis();
                }
                else
                {
                    Debug_PrintLine("[CLOUD] Report failed; reconnecting.");
                    HuaweiIoTDA_Disconnect();
                    g_wifiReady = 0U;
                }
            }
#endif
        }

#if CLOUD_UPLOAD_ENABLE
        if ((HuaweiIoTDA_IsConnected() != 0U) &&
            ((uint32_t)(Millis() - lastPing) >= MQTT_PING_PERIOD_MS))
        {
            lastPing = Millis();
            if (HuaweiIoTDA_Ping())
            {
                Debug_PrintLine("[CLOUD] MQTT PINGRESP OK.");
            }
            else
            {
                Debug_PrintLine("[CLOUD] MQTT ping failed; reconnecting.");
                HuaweiIoTDA_Disconnect();
                g_wifiReady = 0U;
            }
        }
#endif
        Delay_ms(10U);
    }
}

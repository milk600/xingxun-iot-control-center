#ifndef APP_CONFIG_H
#define APP_CONFIG_H

/* ESP-12F / ESP8266 requires a 2.4 GHz Wi-Fi network. */
#define WIFI_SSID               "YOUR_2_4_GHZ_WIFI"
#define WIFI_PASSWORD           "YOUR_WIFI_PASSWORD"

/* Huawei Cloud IoTDA device-side MQTT access information. */
#define IOTDA_BROKER_HOST       "YOUR_DEVICE_ENDPOINT"
#define IOTDA_BROKER_PORT       1883U
#define IOTDA_DEVICE_ID         "YOUR_DEVICE_ID"
#define IOTDA_DEVICE_SECRET     "YOUR_DEVICE_SECRET"

/* Signature type 0 keeps the timestamp field but does not verify wall time. */
#define IOTDA_AUTH_TIMESTAMP    "2025010100"
#define IOTDA_SERVICE_ID        "Environment"

#define DEBUG_UART_BAUD         115200U
#define DEBUG_MIRROR_USART2     0U
#define ESP_UART_BAUD           115200U
#define SENSOR_UPLOAD_PERIOD_MS 1000U
#define MQTT_PING_PERIOD_MS     60000U
#define RECONNECT_PERIOD_MS     5000U

#define LIGHT_SENSOR_INVERT     0U
#define CLOUD_UPLOAD_ENABLE     1U

/* Never enable CLOUD_DEBUG_AUTH outside an isolated local test. */
#define ESP_AT_DEBUG            1
#define CLOUD_DEBUG_PAYLOAD     1
#define CLOUD_DEBUG_AUTH        0

#endif

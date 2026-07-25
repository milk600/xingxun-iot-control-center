# STM32F103 + ESP-12F 环境采集固件

该子项目用于把 DHT11、光敏传感器和 JW01 气体传感器数据上报到华为云 IoTDA。工程面向 STM32F103C8、Keil MDK 和 ESP-AT 固件，不依赖 HAL。

> 该固件使用 MQTT/TCP 1883，不提供 TLS。它适合隔离网络中的研究与演示，不应直接用于生产危化现场。

## 硬件连接

| 功能 | STM32 引脚 | 说明 |
| --- | --- | --- |
| DHT11 DATA | PB5 | 裸传感器需要 4.7k–10k 上拉 |
| 光敏模拟量 | PA1 / ADC1_IN1 | 连接 AO |
| JW01 数据输出 | PA3 / USART2_RX | 9600-8-N-1 |
| ESP RX | PB10 / USART3_TX | STM32 TX 接 ESP RX |
| ESP TX | PB11 / USART3_RX | STM32 RX 接 ESP TX |
| 调试串口 | PA9 / USART1_TX | 115200-8-N-1 |

所有模块必须共地。ESP-12F 使用 3.3 V 电源，并需要足够的峰值电流能力。

## 构建环境

- Keil MDK 5
- `Keil::STM32F1xx_DFP`
- ST-Link 或兼容下载器
- ESP-12F/ESP8266 AT 固件

## 配置

真实 Wi-Fi 和设备凭据不得提交到 Git：

```powershell
Copy-Item User\app_config.example.h User\app_config.h
```

随后只在本机编辑 `User/app_config.h`：

- `WIFI_SSID`
- `WIFI_PASSWORD`
- `IOTDA_BROKER_HOST`
- `IOTDA_DEVICE_ID`
- `IOTDA_DEVICE_SECRET`

`User/app_config.h`、Keil 用户文件、HEX/AXF/OBJ 和构建日志均已被根目录 `.gitignore` 排除。

## 编译与下载

1. 打开 `project.uvprojx`。
2. 安装缺少的 STM32F1 设备包。
3. 选择 `Project → Rebuild all target files`。
4. 确认构建为 `0 Error(s)`。
5. 使用 ST-Link 下载并复位。
6. 在 USART1 上以 115200-8-N-1 查看日志。

不要只执行单文件 Compile；首次构建必须完整 Rebuild。

## IoTDA 产品模型

服务 ID 为 `Environment`，属性名区分大小写：

| 属性 | 类型 | 单位 |
| --- | --- | --- |
| `temperature` | int | °C |
| `humidity` | int | %RH |
| `lightRaw` | int | — |
| `lightPercent` | int | % |
| `TVOC` | float | mg/m³ |
| `ch2o` | float | mg/m³ |
| `co2` | int | ppm |

更多配置见 [Cloud/huawei_cloud_steps.md](Cloud/huawei_cloud_steps.md)。

## 安全注意事项

- 不要开启 `CLOUD_DEBUG_AUTH`；它会输出派生的 MQTT 鉴权值。
- 不要把设备密钥写入截图、日志、Issue 或构建产物。
- 发现凭据进入 Git、聊天记录或固件包后，应立即更换 Wi-Fi 密码并在 IoTDA 重置设备密钥。
- 生产部署应使用支持 TLS 的设备链路和最小权限凭据。

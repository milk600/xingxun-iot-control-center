# 华为云 IoTDA 配置步骤

1. 进入当前 IoTDA 实例，创建 MQTT + JSON 产品。
2. 产品模型中新建服务 `Environment`。
3. 添加属性 `temperature`、`humidity`、`lightRaw`、`lightPercent`（均为 int），以及
   `TVOC`、`ch2o`（均为 float，单位 mg/m³）、`co2`（int，单位 ppm）。名称大小写敏感，
   `TVOC` 必须为大写。
4. 注册密钥认证的直连设备，并把设备 ID、设备密钥保存在本机私有配置中。
5. 在实例右上角“接入信息”复制设备侧 MQTT 域名。
6. 普通 MQTT 使用端口 1883；本工程未实现 TLS，不要改成 8883。
7. 固件上报 Topic：`$oc/devices/{device_id}/sys/properties/report`。
8. 设备第一次 MQTT 鉴权成功后，控制台状态会从“未激活”变为“在线”。

复制 `User/app_config.example.h` 为 `User/app_config.h` 后再填写参数。真实配置已被 Git 忽略，不要提交。

# Huawei Cloud IoTDA product model

Create one service:

- Service ID: `Environment`

Create seven readable properties:

| Property | Type | Min | Max | Unit |
|---|---|---:|---:|---|
| `temperature` | int | -40 | 80 | °C |
| `humidity` | int | 0 | 100 | %RH |
| `lightRaw` | int | 0 | 4095 | none |
| `lightPercent` | int | 0 | 100 | % |
| `TVOC` | float | 0 | 10 | mg/m³ |
| `ch2o` | float | 0 | 5 | mg/m³ |
| `co2` | int | 400 | 5000 | ppm |

All names are case-sensitive and must match the firmware exactly. Note `TVOC` is
upper-case in the firmware payload (`"TVOC":...`); `ch2o` and `co2` are lower-case.

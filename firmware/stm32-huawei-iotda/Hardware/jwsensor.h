#ifndef JWSENSOR_H
#define JWSENSOR_H

#include <stdint.h>

/* JW01 VOC 三合一气体传感器 —— 数据结构与接口声明
 *
 * 传感器型号：JW01（TVOC + CH2O + CO2 三合一）
 * 接口：硬件串口 USART2（PA3 = USART2_RX，5V 耐受引脚），9600-8-N-1
 *       接 JW01 模块的 B 脚（TX 数据输出）。A 脚（RX 命令输入）悬空。
 *
 * 协议移植自辰哥官方参考代码（SYSTEM/usart3/usart3.c）：
 *   一帧 9 字节：[0x2C][B2][B3..B8][B9]
 *     B1 = 0x2C（帧起始；参考代码以 Res==0x2C 作为接收开始标志）
 *     B2 = 0xE4（固定标识，参考代码不校验此字节）
 *     B3,B4 = TVOC 高/低（单位 0.001 mg/m³）
 *     B5,B6 = CH2O 高/低（甲醛，单位 0.001 mg/m³）
 *     B7,B8 = CO2  高/低（单位 ppm）
 *     B9 = 校验和 = (B1+...+B8) 的低 8 位
 *
 * 注：本工程原本用 PA0 软件 UART 接收，但 PA0 非 5V 耐受且实测出现“线上无信号”
 *     死线，故改到 PA3（USART2_RX，FT 5V 耐受）。需把 app_config.h 的
 *     DEBUG_MIRROR_USART2 设为 0，释放 PA2/PA3 供 JW01 使用。
 */

typedef struct {
    uint16_t tvoc;    /* TVOC 总挥发性有机物（原始值 ×1000 = mg/m³） */
    uint16_t ch2o;    /* 甲醛浓度（原始值 ×1000 = mg/m³） */
    uint16_t co2;     /* 二氧化碳浓度（ppm） */
    uint8_t  valid;   /* 本次读数是否有效：1=有效，0=无效 */
} JWSensor_Data;

/* JWSensor_ReadFrame() 返回 0 时，JWSensor_LastError 标明失败原因： */
#define JWERR_OK           0U   /* 成功（无错误） */
#define JWERR_NO_ACTIVITY  1U   /* 线上无信号：USART2 接收缓冲区长时间为空 */
#define JWERR_SYNC_TIMEOUT 2U   /* 同步超时：150ms 内未找到帧起始 0x2C */
#define JWERR_CHECKSUM     3U   /* 校验错：收到 9 字节但校验和不匹配（干扰/波特偏差） */

/* 全局错误码：最近一次 ReadFrame 失败时写入，供上层诊断打印使用 */
extern uint8_t JWSensor_LastError;

void    JWSensor_Init(void);           /* 初始化 USART2（PA3）为 JW01 接收 */
uint8_t JWSensor_ReadFrame(JWSensor_Data *data);   /* 读取并解析一帧数据 */

uint32_t JWSensor_RxTotal(void);       /* 自启动以来 USART2 接收字节总数（诊断用） */
uint32_t JWSensor_RxOverflow(void);    /* USART2 接收环形缓冲溢出次数（诊断用） */

#endif

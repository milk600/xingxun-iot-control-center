#include "jwsensor.h"
#include "uart.h"
#include "delay.h"
#include "stm32f103x8.h"

/* =========================================================================
 * JW01 VOC 三合一气体传感器 —— 硬件串口（USART2）接收驱动
 *                                    （纯寄存器版，无 HAL/库）
 *B接PA3
 * 接口：STM32F103 的 USART2（PA3 = USART2_RX）接收 JW01 模块广播的 UART 帧。
 *   - PA2 / PA3 原本被用作“调试日志镜像输出”，已通过 app_config.h 中
 *     DEBUG_MIRROR_USART2=0 关闭该镜像，从而把 USART2 释放给 JW01 使用。
 *   - 调试日志仍从 USART1（PA9/PA10）正常打印，不受影响。
 *
 * 为什么用硬件串口而不是软件 UART：
 *   - JW01 输出是 5V TTL 电平，而本工程早期用的 PA0 不是 5V 耐受引脚，
 *     长期直连有损坏 MCU 的风险（且实测 PA0 出现“线上无信号”死线）。
 *   - PA3（标注 FT）是 5V 耐受引脚，可直接接 JW01 的 5V TTL 输出。
 *   - 硬件串口由 USART2 外设 + 中断接收，不占用 CPU 轮询采样，
 *     彻底避免软件 UART 因中断打断采样窗口而漏字节 / 错位的问题。
 *
 * 协议（与辰哥官方参考代码 SYSTEM/usart3/usart3.c 一致）：
 *   - 波特率 9600，8 数据位，1 停止位，无校验（8-N-1）
 *   - 模块上电后自动连续广播，MCU 只听，不向模块发送任何命令
 *   - 每帧 9 字节：[0x2C][B2][B3..B8][B9]
 *       B1 = 0x2C（帧起始；参考代码 if(Res==0x2C) 即开始接收）
 *       B2 = 0xE4（固定标识，参考代码不校验此字节）
 *       B3,B4 = TVOC 高/低（单位 0.001 mg/m³）
 *       B5,B6 = CH2O 高/低（甲醛，单位 0.001 mg/m³）
 *       B7,B8 = CO2  高/低（单位 ppm）
 *       B9 = 校验和 = (B1+...+B8) 的低 8 位
 * ========================================================================= */

/* 帧同步 / 单字节接收超时（毫秒） */
#define FRAME_TO_MS   150U    /* 在连续数据流中找帧头的最长等待 */
#define BYTE_TO_MS    50U     /* 接收单个字节的最长等待 */

/* 帧起始字节：参考代码以 Res==0x2C 作为接收开始标志，故只认 0x2C。 */
#define JW_HEADER      0x2CU

uint8_t JWSensor_LastError = JWERR_OK;

/* -------------------------------------------------------------------------
 * 初始化 JW01 硬件串口（USART2，PA3 为 RX）。
 * 实际工作由 uart.c 的 UART_InitJW01() 完成（配置 GPIO + 波特率 + 中断）。
 * ----------------------------------------------------------------------- */
void JWSensor_Init(void)
{
    UART_InitJW01(9600U);   /* PA3 = USART2_RX，9600-8-N-1，接 JW01 的 B 脚 */
}

/* -------------------------------------------------------------------------
 * 读取并解析一帧 JW01 数据。成功返回 1 并填充 data；失败返回 0 并设置
 * JWSensor_LastError 标明原因。
 *
 * 流程与辰哥参考代码（usart3.c）一一对应：
 *   - 参考：if(Res==0x2C) rev_start=1;  本驱动：在 USART2 接收缓冲区中找 0x2C
 *   - 参考：rev_start 后连续收满 9 字节（含 0x2C 本身）
 *           本驱动：找到 0x2C 后，再从缓冲区读 8 字节，凑成 9 字节 buf[0..8]
 *   - 参考：Get_CH2O 中 sum(buf[0..7])==buf[8] 校验；CH2O=buf[4]*256+buf[5]
 *           本驱动：同样做校验和，并按规格表映射 TVOC/CH2O/CO2
 * ----------------------------------------------------------------------- */
uint8_t JWSensor_ReadFrame(JWSensor_Data *data)
{
    uint8_t buf[9];
    uint8_t b;
    uint8_t i;
    uint32_t start = Millis();

    data->valid = 0U;
    JWSensor_LastError = JWERR_OK;

    /* 阶段 1：在连续数据流中找到帧起始字节 0x2C。
       硬件串口中断已把字节缓存进环形缓冲，这里只负责在流中定位帧头。 */
    while (1)
    {
        if ((uint32_t)(Millis() - start) >= FRAME_TO_MS)
        {
            JWSensor_LastError = JWERR_SYNC_TIMEOUT;   /* 150ms 内没找到 0x2C */
            return 0U;
        }
        if (UART_JW01RxReadTimeout(&b, BYTE_TO_MS) == 0)
        {
            JWSensor_LastError = JWERR_NO_ACTIVITY;     /* 线上无活动（缓冲区空） */
            return 0U;
        }
        if (b == JW_HEADER)
            break;
    }

    buf[0] = JW_HEADER;

    /* 阶段 2：再读 8 字节（buf[1]..buf[8]），凑足一帧 9 字节 */
    for (i = 1U; i < 9U; i++)
    {
        if (UART_JW01RxReadTimeout(&b, BYTE_TO_MS) == 0)
        {
            JWSensor_LastError = JWERR_NO_ACTIVITY;
            return 0U;
        }
        buf[i] = b;
    }

    /* 阶段 3：校验和 = 前 8 字节之和的低 8 位，必须等于第 9 字节（buf[8]）。
       与参考代码 Get_CH2O 中 sum(buf[0..7]) == buf[8] 完全一致。 */
    {
        uint8_t sum = 0U;
        for (i = 0U; i < 8U; i++)
            sum += buf[i];
        if (sum != buf[8])
        {
            JWSensor_LastError = JWERR_CHECKSUM;   /* 校验错，多半是干扰/波特偏差 */
            return 0U;
        }
    }

    /* 阶段 4：解析三个气体量（大端序：高位在前、低位在后；
       与参考代码 buf[4]*256+buf[5] 一致）。
       buf[0]=0x2C, buf[1]=B2(0xE4), buf[2..3]=TVOC, buf[4..5]=CH2O, buf[6..7]=CO2 */
    data->tvoc = ((uint16_t)buf[2] << 8) | buf[3];   /* B3(高) B4(低) */
    data->ch2o = ((uint16_t)buf[4] << 8) | buf[5];   /* B5(高) B6(低) */
    data->co2  = ((uint16_t)buf[6] << 8) | buf[7];   /* B7(高) B8(低) */
    data->valid = 1U;
    return 1U;
}

/* -------------------------------------------------------------------------
 * 诊断接口：返回自启动以来 USART2 已接收的字节总数 / 溢出次数。
 *   - RxTotal 一直为 0 → 硬件上 PA3 没收到任何字节（线没接实 / 接错脚 / 模块没发）
 *   - RxTotal 持续增长但 ReadFrame 仍失败 → 多半是波特率 / 极性不对，定位到 err=2/3
 * ----------------------------------------------------------------------- */
uint32_t JWSensor_RxTotal(void)
{
    return UART_JW01RxTotalCount();
}

uint32_t JWSensor_RxOverflow(void)
{
    return UART_JW01RxOverflowCount();
}

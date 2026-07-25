# 参与贡献

感谢你愿意改进危化智巡。项目同时涉及 Web、边缘设备、移动端和嵌入式固件，请优先提交范围清晰、可验证的小改动。

## 开始之前

- 不要提交 API Key、云账号、设备密钥、Wi-Fi 密码、私网地址或本地认证数据。
- 不要提交真实场地照片、点云、遥测、APK、模型权重或厂商 SDK。
- 新功能应在无云凭据、无真实硬件时保持可启动，优先提供 Mock 或降级路径。
- 涉及车辆运动、报警或危险环境判断的改动，必须说明失败模式和安全边界。

## 本地开发

需要 Node.js 22.13 或更高版本。

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Windows PowerShell 可使用：

```powershell
Copy-Item .env.example .env.local
```

`.env.local` 只用于本机，已由 `.gitignore` 排除。

## 提交前检查

```bash
npm run lint
npm run test:agent
npm test
python -m unittest discover -s scanner/tests -v
```

Jetson 纯算法与协议测试：

```bash
cd jetson
python -m unittest discover -p "test_*.py" -v
```

Android、Jetson 硬件和 STM32 相关改动，请在 Pull Request 中注明实际验证的平台、版本和硬件；无法验证的部分也应明确写出。

## Pull Request

Pull Request 应包含：

1. 问题与目标；
2. 主要实现和安全影响；
3. 测试方法与结果；
4. 界面改动的截图或录屏；
5. 尚未覆盖的限制。

请勿在 Issue、日志、截图或测试数据中粘贴真实凭据。安全漏洞请按 [SECURITY.md](SECURITY.md) 私下报告。

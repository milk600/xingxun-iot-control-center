# Android 客户端

`android/` 将前端离线构建产物封装到原生 WebView，并提供相机、语音、文件导出、遥测与车辆控制等原生桥接能力。

公开仓库不包含 API 密钥、云账号、设备标识、本地登录哈希、签名密钥、APK 或生成后的 Web Assets。这些内容均不应进入版本控制。

## 环境要求

- Node.js 与 npm，版本要求见仓库根目录 `package.json`；
- JDK 11；
- Android SDK Platform 32；
- Android SDK Build Tools 30.0.3；
- 可选：Android Studio 与 `adb`。

项目使用 Gradle Wrapper 6.7.1 和 Android Gradle Plugin 4.2.2。首次运行 Wrapper 时会下载对应 Gradle 发行包。

在仓库根目录安装前端依赖：

```powershell
npm ci
```

Android Studio 可以自动配置 SDK。若使用命令行，可通过环境变量提供 SDK 位置，或创建本机专用的 `android/local.properties`。该文件已被 `.gitignore` 排除。

## 构建流程

Android 构建分两步：

1. Vite 生成离线 Web Assets；
2. Gradle 将这些资源和原生代码打包为 APK。

完整 Debug 构建：

```powershell
npm run android:debug
```

等价的分步命令：

```powershell
npm run build:android-web
android\gradlew.bat -p android lintDebug assembleDebug
```

Debug APK 默认位于：

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

生成 Release 构建：

```powershell
npm run android:release
```

`android:share` 作为兼容别名保留。输出默认是未签名的、无凭据 Release APK，不能直接作为正式商店或生产发行包。请在受控的发布流程中使用独立签名配置，并妥善保管 keystore。

`android/app/src/main/assets/web/`、Gradle 构建目录、APK、AAB、`local.properties`、`auth.properties` 和签名文件均被 `.gitignore` 排除。

## Debug 与 Release 的安全差异

这是本项目最重要的 Android 构建边界：

| 构建类型 | 本地配置 | 凭据处理 | 适用范围 |
| --- | --- | --- | --- |
| Debug | 可读取被忽略的 `.env.local` 与 `android/auth.properties` | 可能写入 `BuildConfig` 并随 APK 打包 | 单人、受控设备上的集成调试 |
| Release | 不使用本地密钥字段 | 登录资料、云密钥、设备标识和工作区标识被强制置空 | 安全基线与后续正式集成 |

即使源文件和 `.env.local` 没有提交，Debug APK 仍可能包含构建时注入的内容。APK 可以被反编译，因此：

- 不要上传、分享或长期保存包含真实配置的 Debug APK；
- 调试完成后删除旧包，并在曾经外泄时立即轮换对应凭据；
- 不要把长期云 AK/SK、DeepSeek API Key、DashScope API Key 或其他服务密钥放进移动端；
- Release 构建不会因为本机存在 `.env.local` 而重新嵌入这些密钥。

无凭据 Release 包中的云端功能默认不可用。正式部署应让 App 调用受信任的后端网关，由网关在服务端保存密钥、校验用户身份、限制权限并记录审计日志。

## 本地登录配置

需要调试本地登录时，可以运行：

```powershell
npm run auth:setup
```

该命令生成被忽略的 `android/auth.properties`。它只应用于 Debug 构建；不要复制到文档、Issue、日志或发布包中。

不配置本地登录信息也可以执行 Release 构建。

## 安装与调试

安装 Debug APK：

```powershell
adb install -r android\app\build\outputs\apk\debug\app-debug.apk
```

Debug WebView 可通过桌面 Chrome 的 `chrome://inspect` 检查。测试设备应使用较新的 Android System WebView，以支持 WebGL、Web Worker、ES Module 与 IndexedDB。

修改共享 React 页面后，必须重新运行离线 Web 构建和 Gradle 构建。不要直接编辑生成目录 `android/app/src/main/assets/web/`。

## 网络与权限

Manifest 声明了网络、网络状态、相机、麦克风和生物识别相关权限。只有在对应功能确实需要时才请求运行时权限，并在发布前更新隐私说明。

当前工程允许明文流量，以便在隔离局域网中调试本地 WebSocket 设备。这不适合直接用于互联网或不可信网络。生产版本应使用 TLS、身份验证、最小权限和 Android Network Security Configuration，并关闭不必要的明文流量。

车辆控制连接断开、页面退出或用户登出时，客户端会尝试发送停车指令；这不能替代车辆侧 watchdog、硬件急停和独立的失联保护。

## 发布检查清单

- 使用干净环境重新构建 Release；
- 检查 `BuildConfig` 和 APK 字符串中没有密钥、账号、私网地址或个人信息；
- 使用独立的正式签名密钥签名，并避免把口令写入 Gradle 文件；
- 检查应用权限、明文网络策略和隐私政策；
- 在无 `.env.local`、无 `auth.properties` 的环境中验证构建可重复；
- 对云端请求使用受信任网关，不在 APK 内恢复长期凭据；
- 在受控设备和安全区域验证车辆断连停车与硬件急停。

## 常见问题

- 找不到 Android SDK：通过 Android Studio 安装 Platform 32 和 Build Tools 30.0.3，再配置 SDK 环境变量或本地 `local.properties`。
- Java 版本不兼容：使用 JDK 11，并确认 Gradle 进程没有继承其他 Java 路径。
- 页面仍是旧版本：删除生成的 Web Assets 后重新运行 `npm run android:debug`；不要手工修改生成目录。
- Release 云功能不可用：这是预期的安全行为；请接入受信任后端，而不是向 APK 注入长期密钥。
- Debug 包意外外发：删除公开附件并立即轮换其中可能包含的所有凭据，重新生成无凭据构建。

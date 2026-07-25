@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist "node_modules" (
  echo [错误] 尚未安装网页依赖。
  echo 请先在本目录打开 PowerShell，运行：npm install
  pause
  exit /b 1
)

echo 正在启动本地物联网网站……
echo 启动成功后，请在浏览器打开：http://localhost:3000
echo 数字孪生页面：http://localhost:3000/digital-twin
echo.
echo 按 Ctrl+C 可以停止网站。
echo.

call npm run dev

echo.
echo 本地网站已停止。
pause

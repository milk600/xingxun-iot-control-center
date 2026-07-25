@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 危化智巡智能中枢

if not exist node_modules (
  echo 正在安装依赖，请稍候...
  call npm install --registry=https://registry.npmmirror.com
  if errorlevel 1 goto :error
)

echo 正在启动网页与 DeepSeek 智能网关...
echo 请保持此窗口开启。
call npm run agent:dev
goto :end

:error
echo.
echo 启动失败，请检查 Node.js 和网络连接。
pause

:end

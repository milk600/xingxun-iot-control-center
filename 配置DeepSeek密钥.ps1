$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$envPath = Join-Path $projectRoot ".env.local"
if (-not (Test-Path -LiteralPath $envPath)) {
    throw "未找到 .env.local，请确认脚本位于项目根目录。"
}

Write-Host "请输入重新生成的 DeepSeek 官方 API Key。输入内容不会显示在窗口中。" -ForegroundColor Cyan
$secureKey = Read-Host "DeepSeek API Key" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try {
    $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    if ([string]::IsNullOrWhiteSpace($plainKey) -or -not $plainKey.StartsWith("sk-") -or $plainKey.Length -lt 20) {
        throw "密钥格式不正确，未修改配置。"
    }

    $content = [IO.File]::ReadAllText($envPath, [Text.Encoding]::UTF8)
    if ($content -match "(?m)^DEEPSEEK_API_KEY=") {
        $content = [Text.RegularExpressions.Regex]::Replace(
            $content,
            "(?m)^DEEPSEEK_API_KEY=.*$",
            "DEEPSEEK_API_KEY=$plainKey"
        )
    } else {
        $content = "DEEPSEEK_API_KEY=$plainKey`r`n$content"
    }
    [IO.File]::WriteAllText($envPath, $content, [Text.UTF8Encoding]::new($false))
    Write-Host "DeepSeek 官方 Key 已安全写入本机 .env.local。" -ForegroundColor Green
    Write-Host "现在可以运行：npm run iotctl -- doctor" -ForegroundColor Gray
} finally {
    if ($bstr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
    $plainKey = $null
}

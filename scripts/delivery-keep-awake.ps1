$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class XingXunKeepAwake
{
    [StructLayout(LayoutKind.Sequential)]
    public struct ReasonContext
    {
        public UInt32 Version;
        public UInt32 Flags;
        public IntPtr Reason;
    }

    public enum PowerRequestType
    {
        SystemRequired = 0,
        ExecutionRequired = 3
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr PowerCreateRequest(ref ReasonContext context);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool PowerSetRequest(IntPtr handle, PowerRequestType requestType);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool PowerClearRequest(IntPtr handle, PowerRequestType requestType);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr handle);
}
'@

$reason = [Runtime.InteropServices.Marshal]::StringToHGlobalUni(
    'XingXun web and agent gateway are running'
)
$context = [XingXunKeepAwake+ReasonContext]@{
    Version = 0
    Flags = 1
    Reason = $reason
}
$request = [XingXunKeepAwake]::PowerCreateRequest([ref]$context)

if ($request -eq [IntPtr]::Zero -or $request -eq [IntPtr](-1)) {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($reason)
    throw "PowerCreateRequest failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}

$systemRequired = [XingXunKeepAwake+PowerRequestType]::SystemRequired
$executionRequired = [XingXunKeepAwake+PowerRequestType]::ExecutionRequired

try {
    if (-not [XingXunKeepAwake]::PowerSetRequest($request, $systemRequired)) {
        throw "PowerSetRequest(SystemRequired) failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
    if (-not [XingXunKeepAwake]::PowerSetRequest($request, $executionRequired)) {
        throw "PowerSetRequest(ExecutionRequired) failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
    while ($true) {
        Start-Sleep -Seconds 30
    }
}
finally {
    [void][XingXunKeepAwake]::PowerClearRequest($request, $systemRequired)
    [void][XingXunKeepAwake]::PowerClearRequest($request, $executionRequired)
    [void][XingXunKeepAwake]::CloseHandle($request)
    [Runtime.InteropServices.Marshal]::FreeHGlobal($reason)
}

param([Parameter(Mandatory = $true)][string]$Out)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$result = [ordered]@{
  platform          = "windows"
  wtSource          = $null
  pid               = $null
  hwnd              = $null
  foregroundMatched = $false
  sent              = $false
  inputSize         = $null
  sendError         = $null
  delivered         = $false
  bytes             = $null
  notes             = @()
}

function Find-Wt {
  $cmd = Get-Command wt.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $dir = Join-Path $env:RUNNER_TEMP "windows-terminal"
  if (-not (Test-Path (Join-Path $dir "WindowsTerminal.exe"))) {
    $zip = Join-Path $env:RUNNER_TEMP "wt.zip"
    $unpacked = Join-Path $env:RUNNER_TEMP "wt_unpacked"
    $url = "https://github.com/microsoft/terminal/releases/download/v1.21.2361.0/Microsoft.WindowsTerminal_1.21.2361.0_x64.zip"
    Invoke-WebRequest -Uri $url -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $unpacked -Force
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Copy-Item -Path (Join-Path $unpacked "terminal-*\*") -Destination $dir -Recurse -Force
    New-Item -ItemType File -Force -Path (Join-Path $dir ".portable") | Out-Null
    $settings = Join-Path $dir "settings"
    New-Item -ItemType Directory -Force -Path $settings | Out-Null
    '{"$schema":"https://aka.ms/terminal-profiles-schema","profiles":{"defaults":{"closeOnExit":"always"}}}' |
      Set-Content (Join-Path $settings "settings.json")
  }
  return (Join-Path $dir "WindowsTerminal.exe")
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class Spike {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KEYBDINPUT ki; [FieldOffset(8)] public MOUSEINPUT mi; }
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  public static int lastError;
  public static int InputSize() { return Marshal.SizeOf(typeof(INPUT)); }
  public static IntPtr FindWindow(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p;
      GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h) && GetWindowTextLength(h) > 0) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static bool SendA() {
    INPUT[] inputs = new INPUT[2];
    inputs[0].type = 1; inputs[0].ki.wVk = 0x41;
    inputs[1].type = 1; inputs[1].ki.wVk = 0x41; inputs[1].ki.dwFlags = 2;
    uint sent = SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
    lastError = Marshal.GetLastWin32Error();
    return sent == 2;
  }
}
"@

$before = @(Get-Process WindowsTerminal -ErrorAction SilentlyContinue | ForEach-Object Id)
$reader = Join-Path $PSScriptRoot "input-spike-reader.mjs"
$received = Join-Path $Out "received.bin"
Remove-Item -Force $received -ErrorAction SilentlyContinue

$wt = Find-Wt
$result.wtSource = $wt
Start-Process -FilePath $wt -ArgumentList @("new-tab", "powershell", "-NoExit", "-Command", "node $reader $received")
Start-Sleep -Seconds 3

$after = @(Get-Process WindowsTerminal -ErrorAction SilentlyContinue)
$new = $after | Where-Object { $before -notcontains $_.Id } | Select-Object -First 1
if (-not $new) { $new = $after | Select-Object -First 1 }
if (-not $new) {
  $result.notes += "no WindowsTerminal process after launch"
  $result | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $Out "result.json")
  Get-Content (Join-Path $Out "result.json")
  exit 0
}
$result.pid = $new.Id

$hwnd = [IntPtr]::Zero
for ($i = 0; $i -lt 20 -and $hwnd -eq [IntPtr]::Zero; $i++) {
  Start-Sleep -Milliseconds 500
  $hwnd = [Spike]::FindWindow([uint32]$new.Id)
}
if ($hwnd -eq [IntPtr]::Zero) {
  $result.notes += "no visible top-level window for the WindowsTerminal pid"
  $result | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $Out "result.json")
  Get-Content (Join-Path $Out "result.json")
  exit 0
}
$result.hwnd = $hwnd.ToInt64()

[Spike]::ShowWindow($hwnd, 9) | Out-Null
[Spike]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 700
$fg = [Spike]::GetForegroundWindow()
$fgPid = [uint32]0
[Spike]::GetWindowThreadProcessId($fg, [ref]$fgPid) | Out-Null
$result.foregroundMatched = ($fgPid -eq [uint32]$new.Id)

if (-not $result.foregroundMatched) {
  $fgThread = [Spike]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  [Spike]::AttachThreadInput([Spike]::GetCurrentThreadId(), $fgThread, $true) | Out-Null
  [Spike]::SetForegroundWindow($hwnd) | Out-Null
  [Spike]::AttachThreadInput([Spike]::GetCurrentThreadId(), $fgThread, $false) | Out-Null
  Start-Sleep -Milliseconds 500
  $fg = [Spike]::GetForegroundWindow()
  [Spike]::GetWindowThreadProcessId($fg, [ref]$fgPid) | Out-Null
  $result.foregroundMatched = ($fgPid -eq [uint32]$new.Id)
}

$result.inputSize = [Spike]::InputSize()
$result.sent = [Spike]::SendA()
$result.sendError = [Spike]::lastError
Start-Sleep -Seconds 2
$result.delivered = Test-Path $received
if ($result.delivered) { $result.bytes = (Format-Hex -Path $received | Out-String) }

$result | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $Out "result.json")
Get-Content (Join-Path $Out "result.json")

<#
start.ps1 —— 起本机常驻 embedding 服务（Windows）

为什么要有它：Linux/macOS 那条 `setsid nohup node server.mjs ... &` 在 Windows 上没有对应物，
而 PowerShell 起后台进程的参数引号是著名的坑（路径带空格就把命令行切错）。这里一次性写对。

**启停归用户**：这个脚本由你自己敲。插件（src/memory/*）从不 spawn 子服务、不自愈、不 kill，
服务不可达时召回只降级成字面档。

监听地址在 server.mjs 里写死 127.0.0.1，这里连参数都不给 —— 这台机器如果局域网可达，
开成 0.0.0.0 等于把「送进来的都是聊天正文」的接口开放给整栋楼。

用法：
  powershell -ExecutionPolicy Bypass -File .\start.ps1
  powershell -ExecutionPolicy Bypass -File .\start.ps1 -Port 9000 -ModelDir "D:\akane\model"
#>
param(
  [int]$Port = 8765,
  [string]$ModelDir = "",
  [int]$Threads = 1
)

$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $env:USERPROFILE "akane-embed.log"
$errLog = Join-Path $env:USERPROFILE "akane-embed.err.log"
$pidFile = Join-Path $env:USERPROFILE ".akane-embed.pid"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "[akane-embed] 找不到 node —— 本服务只跑在 Node 上（实测 v22.20.0，要求 >=20.3）"
  exit 2
}

# 已在跑就别起第二个：端口被占时 server.mjs 会直接抛 EADDRINUSE
try {
  $alive = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
  Write-Host "[akane-embed] $Port 端口上已经有服务在跑：model=$($alive.model) dims=$($alive.dims)"
  exit 0
} catch {
  # 连不上才是「该起一个」的信号，别的都不算
}

$command = @("`"$here\server.mjs`"", "--port", "$Port")
if ($ModelDir -ne "") { $command += @("--model-dir", "`"$ModelDir`"") }

$env:AKANE_EMBED_THREADS = "$Threads"
$proc = Start-Process -FilePath $node.Source -ArgumentList $command `
  -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $log -RedirectStandardError $errLog

$proc.Id | Out-File -Encoding ascii $pidFile
Write-Host "[akane-embed] 已启动 pid=$($proc.Id)，日志 $log（日志只有条数/维度/毫秒，正文一个字符都不写）"

# 权重与 WASM 要加载一秒上下，轮询到 ready 再交回控制权
for ($i = 0; $i -lt 30; $i += 1) {
  Start-Sleep -Milliseconds 1000
  if ($proc.HasExited) {
    Write-Host "[akane-embed] 进程提前退出（exit=$($proc.ExitCode)），看 $errLog"
    exit 1
  }
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
    Write-Host "[akane-embed] ready：model=$($health.model) dims=$($health.dims)"
    exit 0
  } catch {
    # 继续等
  }
}

Write-Host "[akane-embed] 30s 内 /health 没答，进程还在（pid=$($proc.Id)）—— 查 $errLog 与 $log"
exit 1

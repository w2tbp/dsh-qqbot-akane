<#
stop.ps1 —— 停本机常驻 embedding 服务（Windows）

与 start.ps1 成对。**插件不会做这件事**：它只探测、只调用，不 spawn 也不 kill。

先认 start.ps1 写的 pid 文件；没有就按命令行匹配（只认带 embed-service\server.mjs 的那条
node 进程，避免顺手把别的 node 服务带走 —— 现网的 dsh web 也是 node）。

用法：
  powershell -ExecutionPolicy Bypass -File .\stop.ps1
  powershell -ExecutionPolicy Bypass -File .\stop.ps1 -Port 9000
#>
param(
  [int]$Port = 8765
)

$pidFile = Join-Path $env:USERPROFILE ".akane-embed.pid"
$targets = @()

if (Test-Path $pidFile) {
  $pidFrom = Get-Content $pidFile -TotalCount 1
  $proc = Get-Process -Id $pidFrom -ErrorAction SilentlyContinue
  if ($proc) { $targets += $proc }
  Remove-Item $pidFile -ErrorAction SilentlyContinue
}

if ($targets.Count -eq 0) {
  $pattern = "embed-service*server.mjs*--port $Port"
  $found = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like $pattern }
  foreach ($item in $found) {
    $proc = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
    if ($proc) { $targets += $proc }
  }
}

if ($targets.Count -eq 0) {
  Write-Host "[akane-embed] $Port 端口上没有本服务在跑（没找到 pid，也没匹配到命令行）"
  exit 0
}

foreach ($proc in $targets) {
  # server.mjs 收到终止信号会走 server.close() 再退，给它 5s；还不退才强杀
  $proc.CloseMainWindow() | Out-Null
  if (-not $proc.WaitForExit(5000)) {
    Stop-Process -Id $proc.Id -Force
    Write-Host "[akane-embed] pid=$($proc.Id) 优雅退出超时，已强杀"
  } else {
    Write-Host "[akane-embed] pid=$($proc.Id) 已停止"
  }
}

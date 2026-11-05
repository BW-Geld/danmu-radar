param(
  [int]$Port = 7788,
  [string]$Url = "http://127.0.0.1:7788/"
)

# 弹幕雷达 · 托盘图标
# 由 server/index.js 在「缩到托盘」时拉起；服务退出后自己消失。
# 只用 Windows 自带的 WinForms，不装任何依赖。
# 注意：本文件必须存为 UTF-8 带 BOM，否则 Windows PowerShell 5.1 会按 ANSI 读，中文和引号全部报废。

$ErrorActionPreference = 'Stop'

$dataDir = Join-Path $PSScriptRoot '..\data'
$pidFile = Join-Path $dataDir 'tray.pid'
$errFile = Join-Path $dataDir 'tray-error.log'

# 只允许一个托盘图标：已经有活着的托盘进程就直接退出。
# 服务端那边有 10 秒冷却，但旧进程残留、或两个实例同时起时，还需要这层兜底。
try {
  if (Test-Path $pidFile) {
    $old = 0
    [void][int]::TryParse((Get-Content -Path $pidFile -TotalCount 1 -ErrorAction SilentlyContinue), [ref]$old)
    if ($old -and $old -ne $PID -and (Get-Process -Id $old -ErrorAction SilentlyContinue)) { exit 0 }
  }
} catch { }

try {
  Set-Content -Path $pidFile -Value $PID -Encoding ASCII
} catch { }

$icon = $null
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing

  $form = New-Object System.Windows.Forms.Form
  $form.Text = '弹幕雷达'
  $form.ShowInTaskbar = $false
  $form.WindowState = 'Minimized'
  $form.FormBorderStyle = 'None'
  $form.Opacity = 0
  $form.Size = New-Object System.Drawing.Size(1, 1)
  $form.StartPosition = 'Manual'
  $form.Location = New-Object System.Drawing.Point(-2000, -2000)

  $icon = New-Object System.Windows.Forms.NotifyIcon
  # 自己画一个 32x32 的青绿圆点图标，比系统默认那个「白色小窗口」好认
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $gr = [System.Drawing.Graphics]::FromImage($bmp)
  $gr.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $gr.Clear([System.Drawing.Color]::Transparent)
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#4de0b0'))
  $gr.FillEllipse($brush, 2, 2, 28, 28)
  $font = New-Object System.Drawing.Font 'Microsoft YaHei', 15, ([System.Drawing.FontStyle]::Bold)
  $gr.DrawString('弹', $font, ([System.Drawing.Brushes]::Black), 4, 3)
  $gr.Dispose()
  $icon.Icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
  $icon.Text = '弹幕雷达 · 正在采集'
  $icon.Visible = $true

  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  $open = $menu.Items.Add('打开界面')
  $quit = $menu.Items.Add('停止采集并退出')

  # 优先让服务把已有窗口提到前台；服务里那段逻辑是「有窗口就激活、没有才新开」
  $showUI = {
    $ok = $false
    try {
      Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/ui/activate" -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 8 | Out-Null
      $ok = $true
    } catch { }
    if (-not $ok) { Start-Process $Url }
  }

  $open.add_Click($showUI)

  $quit.add_Click({
    try {
      $body = '{"confirm":true}'
      Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/shutdown" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 5 | Out-Null
    } catch { }
    $icon.Visible = $false
    $form.Close()
  })

  $icon.ContextMenuStrip = $menu
  # 双击图标 = 同一个动作：有窗口就提到前台，没有才开
  $icon.add_DoubleClick($showUI)

  # 服务没了就自己退（每 5 秒探一次）
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 5000
  $timer.add_Tick({
    try {
      Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/stats" -TimeoutSec 3 | Out-Null
    } catch {
      $icon.Visible = $false
      $form.Close()
    }
  })
  $timer.Start()

  $icon.ShowBalloonTip(3000, '弹幕雷达', '已缩到托盘，采集继续。双击图标回到界面。', [System.Windows.Forms.ToolTipIcon]::None)

  [System.Windows.Forms.Application]::Run($form)
} catch {
  try {
    $msg = "$(Get-Date -Format o) $($_.Exception.GetType().Name): $($_.Exception.Message)"
    $msg | Out-File -FilePath $errFile -Encoding UTF8 -Append
  } catch { }
} finally {
  try { if ($icon) { $icon.Visible = $false; $icon.Dispose() } } catch { }
  try { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue } catch { }
}

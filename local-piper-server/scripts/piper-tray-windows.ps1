$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ServerDir = Split-Path -Parent $PSScriptRoot
$StartScript = Join-Path $PSScriptRoot "start-background-windows.ps1"
$StopScript = Join-Path $PSScriptRoot "stop-background-windows.ps1"
$LogDir = Join-Path $ServerDir "logs"
$IconFile = Join-Path (Split-Path -Parent $ServerDir) "extension\icons\icon128.png"
$HealthUrl = "http://127.0.0.1:5050/health"
$AutoStartServer = $true

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$mutex = New-Object System.Threading.Mutex($false, "Local\PiperTtsSimpleTray")
if (-not $mutex.WaitOne(0)) { exit 0 }

function Test-PiperOnline {
  try {
    $response = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 1
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  } catch {
    return $false
  }
}

function Start-PiperServer {
  Start-Process powershell -WindowStyle Hidden -ArgumentList @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $StartScript
  )
}

function Stop-PiperServer {
  Start-Process powershell -WindowStyle Hidden -ArgumentList @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $StopScript
  )
}

function Open-VoicesFolder {
  $voicesDir = Join-Path $ServerDir "piper\voices"
  New-Item -ItemType Directory -Force -Path $voicesDir | Out-Null
  Start-Process explorer.exe -ArgumentList "`"$voicesDir`""
}

function Get-TrayIcon {
  if (Test-Path $IconFile) {
    $bitmap = [System.Drawing.Bitmap]::FromFile($IconFile)
    return [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
  }
  return [System.Drawing.SystemIcons]::Application
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$statusItem = $menu.Items.Add("Piper TTS: checking...")
$statusItem.Enabled = $false
$menu.Items.Add("-") | Out-Null
$startItem = $menu.Items.Add("Start Server")
$stopItem = $menu.Items.Add("Stop Server")
$menu.Items.Add("-") | Out-Null
$voicesItem = $menu.Items.Add("Open Voices Folder")
$exitItem = $menu.Items.Add("Exit")

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = Get-TrayIcon
$tray.Text = "Piper TTS"
$tray.ContextMenuStrip = $menu
$tray.Visible = $true

function Update-Tray {
  $online = Test-PiperOnline
  $statusItem.Text = if ($online) { "Piper TTS: online" } else { "Piper TTS: offline" }
  $tray.Text = if ($online) { "Piper TTS - online" } else { "Piper TTS - offline" }
  $startItem.Enabled = -not $online
  $stopItem.Enabled = $online
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.Add_Tick({ Update-Tray })

$startItem.Add_Click({
  Start-PiperServer
  Start-Sleep -Milliseconds 700
  Update-Tray
})

$stopItem.Add_Click({
  Stop-PiperServer
  Start-Sleep -Milliseconds 700
  Update-Tray
})

$voicesItem.Add_Click({ Open-VoicesFolder })

$exitItem.Add_Click({
  $timer.Stop()
  $tray.Visible = $false
  $tray.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

Update-Tray
if ($AutoStartServer -and -not (Test-PiperOnline)) {
  Start-PiperServer
  Start-Sleep -Milliseconds 700
  Update-Tray
}
$timer.Start()
[System.Windows.Forms.Application]::Run()

try { $mutex.ReleaseMutex() | Out-Null } catch {}
$mutex.Dispose()

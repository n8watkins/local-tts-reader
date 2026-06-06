$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
public static extern bool DestroyIcon(System.IntPtr hIcon);
"@

$ServerDir = Split-Path -Parent $PSScriptRoot
$StartScript = Join-Path $PSScriptRoot "start-background-windows.ps1"
$StopScript = Join-Path $PSScriptRoot "stop-background-windows.ps1"
$LogDir = Join-Path $ServerDir "logs"
$PidFile = Join-Path $LogDir "piper-tts-server.pid"
$IconFile = Join-Path (Split-Path -Parent $ServerDir) "extension\icons\icon128.png"
$HealthUrl = "http://127.0.0.1:5050/health"
$AutoStartServer = $true

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$mutex = New-Object System.Threading.Mutex($false, "Local\PiperTtsSimpleTray")
# WaitOne throws AbandonedMutexException if a previous tray was force-killed
# rather than exiting cleanly — that means the lock is now ours, not a conflict,
# so treat it as acquired instead of crashing before the tray loads.
try { $gotLock = $mutex.WaitOne(0) }
catch [System.Threading.AbandonedMutexException] { $gotLock = $true }
if (-not $gotLock) { exit 0 }

function Test-PiperOnline {
  try {
    $response = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 1
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  } catch {
    return $false
  }
}

function Test-ProcessIdRunning {
  param([int]$ProcessId)
  return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Get-ManagedServerPid {
  if (-not (Test-Path $PidFile)) {
    return $null
  }

  try {
    $processId = [int]((Get-Content -LiteralPath $PidFile -Raw).Trim())
    if ($processId -gt 0 -and (Test-ProcessIdRunning $processId)) {
      return $processId
    }
  } catch {}

  return $null
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
    $bitmap = $null
    $handle = [System.IntPtr]::Zero
    try {
      $bitmap = [System.Drawing.Bitmap]::FromFile($IconFile)
      $handle = $bitmap.GetHicon()
      $icon = [System.Drawing.Icon]::FromHandle($handle)
      $clonedIcon = $icon.Clone()
      return [System.Drawing.Icon]$clonedIcon
    } finally {
      if ($handle -ne [System.IntPtr]::Zero) {
        [Win32.NativeMethods]::DestroyIcon($handle) | Out-Null
      }
      if ($bitmap) {
        $bitmap.Dispose()
      }
    }
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
  $managedPid = Get-ManagedServerPid
  $managed = $null -ne $managedPid

  if ($managed) {
    $statusItem.Text = "Piper TTS: online"
    $tray.Text = "Piper TTS - online"
  } elseif ($online) {
    $statusItem.Text = "Piper TTS: online (external)"
    $tray.Text = "Piper TTS - external server"
  } else {
    $statusItem.Text = "Piper TTS: offline"
    $tray.Text = "Piper TTS - offline"
  }

  $startItem.Enabled = -not $online
  $stopItem.Enabled = $managed
  $stopItem.Text = if ($online -and -not $managed) { "Stop Server (managed only)" } else { "Stop Server" }
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

# Left-click the icon to flash whether the server is live (right-click still
# opens the full menu).
$tray.Add_MouseClick({
  param($traySender, $eventArgs)
  if ($eventArgs.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
  Update-Tray
  $online = Test-PiperOnline
  $managed = $null -ne (Get-ManagedServerPid)
  $state = if ($managed) { "online" } elseif ($online) { "online (external server)" } else { "offline" }
  $tray.BalloonTipTitle = "Piper TTS"
  $tray.BalloonTipText = "Server is $state"
  $tray.ShowBalloonTip(2000)
})

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

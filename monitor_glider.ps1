# monitor_glider.ps1 - browser-free simple ground-station monitor (PowerShell only)
#   Reads attitude telemetry from the ground ESP32-C3 (COM12) USB and shows roll/pitch/yaw.
#   Accepts all formats: "DAT," prefixed / 15-col / 17-col (glider_nRF52840).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\monitor_glider.ps1
#   powershell -ExecutionPolicy Bypass -File .\monitor_glider.ps1 -Port COM12 -Baud 115200
#   Send one command on connect:  -Send "status"   /  -Send "/mac"
#   Stop with Ctrl+C.
#
# Note: cannot open the port if the WebUI (browser) or Python already holds it (exclusive).

param(
  [string]$Port = "COM12",
  [int]$Baud = 115200,
  [string]$Send = $null
)

function Fmt($v, $width) {
  $s = [string][math]::Round([double]$v, 1)
  return $s.PadLeft($width)
}

try {
  $sp = New-Object System.IO.Ports.SerialPort $Port, $Baud, 'None', 8, 'one'
  $sp.ReadTimeout = 200
  $sp.NewLine = "`n"
  $sp.DtrEnable = $true
  $sp.RtsEnable = $true
  $sp.Open()
} catch {
  Write-Host "OPEN FAILED ($Port): $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "  -> Make sure no WebUI/Python is holding $Port (exclusive access)." -ForegroundColor Yellow
  exit 1
}

if ($Send) {
  try { $sp.WriteLine($Send); Write-Host "[sent] $Send" -ForegroundColor Cyan } catch {}
}

Write-Host "Monitoring $Port @ $Baud  (Ctrl+C to stop)" -ForegroundColor Green

$count = 0
$rateWin = 0
$hz = 0.0
$rateSw = [Diagnostics.Stopwatch]::StartNew()
$showSw = [Diagnostics.Stopwatch]::StartNew()

try {
  while ($true) {
    $line = $null
    try { $line = ($sp.ReadLine()).Trim() } catch { continue }
    if (-not $line) { continue }

    if ($line.StartsWith('[') -or $line.StartsWith('LOG,')) {
      Write-Host "  $line" -ForegroundColor DarkGray
      continue
    }

    # Strip optional "DAT," prefix so roll/pitch/yaw are always at index 9/10/11.
    $cand = $line
    if ($line.StartsWith('DAT,')) { $cand = $line.Substring(4) }
    $f = $cand.Split(',')
    if ($f.Count -lt 15) { continue }

    $roll = 0.0; $pitch = 0.0; $yaw = 0.0
    $okR = [double]::TryParse($f[9],  [ref]$roll)
    $okP = [double]::TryParse($f[10], [ref]$pitch)
    $okY = [double]::TryParse($f[11], [ref]$yaw)
    if (-not ($okR -and $okP -and $okY)) { continue }

    $count++
    $rateWin++
    if ($rateSw.Elapsed.TotalSeconds -ge 1.0) {
      $hz = $rateWin / $rateSw.Elapsed.TotalSeconds
      $rateWin = 0
      $rateSw.Restart()
    }

    if ($showSw.Elapsed.TotalMilliseconds -ge 150) {
      $showSw.Restart()
      $tilt = [math]::Max([math]::Abs($roll), [math]::Abs($pitch))
      $col = 'White'
      if ($tilt -gt 45) { $col = 'Red' }
      $msg = "ROLL " + (Fmt $roll 7) + "   PITCH " + (Fmt $pitch 7) + "   YAW " + (Fmt $yaw 7) + "   | " + (Fmt $hz 5) + " Hz  rx=" + $count
      Write-Host $msg -ForegroundColor $col
    }
  }
} finally {
  $sp.Close()
  Write-Host ""
  Write-Host "closed $Port (rx=$count)"
}

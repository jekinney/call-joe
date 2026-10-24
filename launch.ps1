# Starts Joe's server if it isn't running, then opens the call window in Edge.
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$url = "http://127.0.0.1:5174"

function Test-Joe {
  try { Invoke-WebRequest "$url/api/status" -UseBasicParsing -TimeoutSec 1 | Out-Null; $true } catch { $false }
}

if (-not (Test-Joe)) {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { $node = "C:\Program Files\nodejs\node.exe" }
  Start-Process $node -ArgumentList "`"$dir\server.mjs`"" -WorkingDirectory $dir -WindowStyle Hidden
  for ($i = 0; $i -lt 40 -and -not (Test-Joe); $i++) { Start-Sleep -Milliseconds 250 }
}

$browser = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
Start-Process $browser "--app=$url --window-size=480,820"

# The tray icon by the clock: minimizing hides the window there, and it comes back when a friend calls (tray.ps1).
Start-Process powershell -ArgumentList "-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$dir\tray.ps1`"" -WindowStyle Hidden

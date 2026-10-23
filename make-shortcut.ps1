# Puts a "Call Joe" shortcut on the desktop that runs launch.ps1.
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Add-Type -AssemblyName System.Drawing

# Draw a simple icon: an orange circle with a phone on it.
$icon = Join-Path $dir "joe.ico"
$bmp = New-Object System.Drawing.Bitmap 64, 64
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = "AntiAlias"
$g.TextRenderingHint = "AntiAliasGridFit"
$g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(217, 140, 63))), 2, 2, 60, 60)
$font = New-Object System.Drawing.Font "Segoe UI Emoji", 26
$g.DrawString([char]::ConvertFromUtf32(0x1F4DE), $font, [System.Drawing.Brushes]::White, 7, 9)
$g.Dispose()
$stream = [System.IO.File]::Create($icon)
[System.Drawing.Icon]::FromHandle($bmp.GetHicon()).Save($stream)
$stream.Close()

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath("Desktop")) "Call Joe.lnk"))
$lnk.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$lnk.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$dir\launch.ps1`""
$lnk.WorkingDirectory = $dir
$lnk.IconLocation = $icon
$lnk.Description = "Call Joe Dirt"
$lnk.Save()
Write-Output "Shortcut created on the desktop."

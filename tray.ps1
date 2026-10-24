# Puts Call Joe in the system tray, by the clock. launch.ps1 starts it next to the call window.
# - Minimizing the window hides it to the tray (not the taskbar). Click the tray icon to bring it back.
# - When a friend calls (the page's title starts with the phone), the window comes back by itself.
# - Right-click the icon: Open, or Quit (closes the window; the server then stops by itself).
# - It exits when the window is closed. Only one runs at a time.
$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

$created = $false
$mutex = New-Object System.Threading.Mutex($true, "CallJoeTray", [ref]$created)
if (-not $created) { exit }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class JoeWin {
  delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public static string Title(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
  // The browser's app window showing the phone: a Chrome/Edge window whose title is the page's.
  public static IntPtr Find() {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => {
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      if (c.ToString() != "Chrome_WidgetWin_1") return true;
      string t = Title(h);
      if (t == "Call Joe" || t.EndsWith(" is calling" + (char)0x2026) || t.EndsWith(" is calling...")) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@

$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = if (Test-Path "$dir\joe.ico") { New-Object System.Drawing.Icon("$dir\joe.ico") } else { [System.Drawing.SystemIcons]::Application }
$icon.Text = "Call Joe"
$icon.Visible = $true

$script:win = [IntPtr]::Zero
$script:seen = $false
function Show-Joe {
  if ($script:win -eq [IntPtr]::Zero -or -not [JoeWin]::IsWindow($script:win)) { return }
  [JoeWin]::ShowWindow($script:win, 9) | Out-Null   # SW_RESTORE: shows it again, un-minimized
  [JoeWin]::SetForegroundWindow($script:win) | Out-Null
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.Items.Add("Open Call Joe", $null, { Show-Joe }) | Out-Null
$menu.Items.Add("Quit", $null, {
  if ($script:win -ne [IntPtr]::Zero) { [JoeWin]::PostMessage($script:win, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null }  # WM_CLOSE
}) | Out-Null
$icon.ContextMenuStrip = $menu
$icon.add_MouseClick({ param($s, $e) if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Show-Joe } })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 300
$timer.add_Tick({
  if ($script:win -eq [IntPtr]::Zero -or -not [JoeWin]::IsWindow($script:win)) {
    $script:win = [JoeWin]::Find()
    if ($script:win -eq [IntPtr]::Zero) {
      # Give the window time to open; once it was open and is now gone, we're done.
      if ($script:seen -or ((Get-Date) - $script:started).TotalSeconds -gt 60) { $timer.Stop(); $icon.Visible = $false; [System.Windows.Forms.Application]::Exit() }
      return
    }
    $script:seen = $true
  }
  $visible = [JoeWin]::IsWindowVisible($script:win)
  if ($visible -and [JoeWin]::IsIconic($script:win)) {
    [JoeWin]::ShowWindow($script:win, 0) | Out-Null  # SW_HIDE: off the taskbar, into the tray
  } elseif (-not $visible -and [JoeWin]::Title($script:win).StartsWith([string][char]::ConvertFromUtf32(0x1F4DE))) {
    Show-Joe  # a friend is calling
  }
})
$script:started = Get-Date
$timer.Start()
[System.Windows.Forms.Application]::Run()
$icon.Dispose()
$mutex.ReleaseMutex()

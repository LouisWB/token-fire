param(
  [string]$Out = "shot.png",
  [string]$Win = "token-fire",
  [ValidateSet("none", "left", "right")] [string]$Click = "none",
  [int]$DX = 0,
  [int]$DY = 0,
  [int]$Repeat = 1,
  [switch]$Clip
)

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Path (Join-Path $PSScriptRoot "click-helper.cs")
[Mouse]::SetProcessDPIAware() | Out-Null

# 按标题找窗口：摆件是 "token-fire"，设置面板是 "token-fire 设置"
# 类名要传真正的 NULL，PowerShell 的 $null 会被编组成空串，匹配不到任何窗口
$hwnd = [Mouse]::FindWindow([NullString]::Value, $Win)
if ($hwnd -eq [IntPtr]::Zero) {
  $proc = Get-Process token-fire -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $proc) { Write-Output "摆件没在运行"; exit 1 }
  $hwnd = $proc.MainWindowHandle
}

$screen = [System.Windows.Forms.SystemInformation]::VirtualScreen

function Get-WinRect {
  $r = New-Object WinRect
  [Mouse]::GetWindowRect($hwnd, [ref]$r) | Out-Null
  return $r
}

# 点击用屏幕坐标；截图用屏幕坐标减去虚拟桌面原点
if ($Click -ne "none") {
  for ($i = 0; $i -lt $Repeat; $i++) {
    $r = Get-WinRect
    $cx = [int](($r.Left + $r.Right) / 2) + $DX
    $cy = [int](($r.Top + $r.Bottom) / 2) + $DY
    [Mouse]::SetCursorPos($cx, $cy) | Out-Null
    Start-Sleep -Milliseconds 300
    if ($Click -eq "right") { [Mouse]::Click(0x0008, 0x0010) } else { [Mouse]::Click(0x0002, 0x0004) }
    Write-Output ("click " + $Click + " " + ($i + 1) + "/" + $Repeat + " at " + $cx + "," + $cy + "  win=" + $r.Left + "," + $r.Top + " " + ($r.Right - $r.Left) + "x" + ($r.Bottom - $r.Top))
    Start-Sleep -Milliseconds 900
  }
  Start-Sleep -Milliseconds 700
}

$full = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$g = [System.Drawing.Graphics]::FromImage($full)
$g.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
$g.Dispose()

$after = Get-WinRect

if ($Clip) {
  $pad = 14
  $x = [Math]::Max(0, $after.Left - $screen.X - $pad)
  $y = [Math]::Max(0, $after.Top - $screen.Y - $pad)
  $w = [Math]::Min(($after.Right - $after.Left) + $pad * 2, $full.Width - $x)
  $h = [Math]::Min(($after.Bottom - $after.Top) + $pad * 2, $full.Height - $y)
  $clipped = New-Object System.Drawing.Bitmap($w, $h)
  $cg = [System.Drawing.Graphics]::FromImage($clipped)
  $dst = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
  $src = New-Object System.Drawing.Rectangle($x, $y, $w, $h)
  $cg.DrawImage($full, $dst, $src, [System.Drawing.GraphicsUnit]::Pixel)
  $cg.Dispose()
  $clipped.Save((Join-Path $PWD $Out), [System.Drawing.Imaging.ImageFormat]::Png)
  $clipped.Dispose()
} else {
  $full.Save((Join-Path $PWD $Out), [System.Drawing.Imaging.ImageFormat]::Png)
}
$full.Dispose()

Write-Output ("saved " + $Out + "  desktop=" + $screen.X + "," + $screen.Y + " " + $screen.Width + "x" + $screen.Height + "  win=" + $after.Left + "," + $after.Top + " " + ($after.Right - $after.Left) + "x" + ($after.Bottom - $after.Top))

# 生成应用图标：assets/danmu-radar.ico（256/48/32，32 位 BMP 条目）
# 用 DIB 而不是 PNG 压缩条目：.NET 的 Icon.ToBitmap 和老外壳对 PNG 条目支持不好
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools\make-icon.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'assets'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
$icoPath = Join-Path $outDir 'danmu-radar.ico'

function New-IconBitmap([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear([System.Drawing.Color]::Transparent)

  $pad = [int][math]::Round($size * 0.055)
  $r = [int][math]::Round($size * 0.22)
  $w = $size - $pad * 2
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc($pad, $pad, $r, $r, 180, 90)
  $path.AddArc($pad + $w - $r, $pad, $r, $r, 270, 90)
  $path.AddArc($pad + $w - $r, $pad + $w - $r, $r, $r, 0, 90)
  $path.AddArc($pad, $pad + $w - $r, $r, $r, 90, 90)
  $path.CloseFigure()

  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point 0, 0),
    (New-Object System.Drawing.Point 0, $size),
    [System.Drawing.Color]::FromArgb(255, 0x5c, 0xe8, 0xb8),
    [System.Drawing.Color]::FromArgb(255, 0x1f, 0x9c, 0x88))
  $g.FillPath($brush, $path)

  $fontSize = [float]($size * 0.56)
  $font = New-Object System.Drawing.Font('Microsoft YaHei', $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $textBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 0x06, 0x16, 0x14))
  $text = [string][char]0x5F39
  $sz = $g.MeasureString($text, $font)
  $g.DrawString($text, $font, $textBrush, [float](($size - $sz.Width) / 2), [float](($size - $sz.Height) / 2))

  $g.Dispose()
  return $bmp
}

# Bitmap -> ICO 里的 DIB（BITMAPINFOHEADER + 自下而上 BGRA + AND 掩码）
function Get-DibBytes([System.Drawing.Bitmap]$bmp) {
  $w = $bmp.Width
  $h = $bmp.Height
  $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $stride = $data.Stride
  $raw = New-Object byte[] ($stride * $h)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $raw, 0, $raw.Length)
  $bmp.UnlockBits($data)

  $maskStride = [int]([math]::Floor(($w + 31) / 32) * 4)
  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($ms)
  $bw.Write([UInt32]40)
  $bw.Write([Int32]$w)
  $bw.Write([Int32]($h * 2))
  $bw.Write([UInt16]1)
  $bw.Write([UInt16]32)
  $bw.Write([UInt32]0)
  $bw.Write([UInt32]($w * $h * 4))
  $bw.Write([Int32]0)
  $bw.Write([Int32]0)
  $bw.Write([UInt32]0)
  $bw.Write([UInt32]0)
  for ($y = $h - 1; $y -ge 0; $y--) {
    $bw.Write($raw, $y * $stride, $w * 4)
  }
  $zeroRow = New-Object byte[] $maskStride
  for ($y = 0; $y -lt $h; $y++) { $bw.Write($zeroRow, 0, $maskStride) }
  $bw.Flush()
  [byte[]]$out = $ms.ToArray()
  $bw.Dispose()
  $ms.Dispose()
  return $out
}

$sizes = @(256, 48, 32)
$images = New-Object System.Collections.ArrayList
foreach ($s in $sizes) {
  $bmp = New-IconBitmap $s
  [byte[]]$dib = Get-DibBytes $bmp
  $bmp.Save((Join-Path $outDir ("icon-$s.png")), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  [void]$images.Add([pscustomobject]@{ Size = $s; Bytes = $dib })
  Write-Host ("  {0} px -> {1} 字节" -f $s, $dib.Length)
}

$fs = New-Object System.IO.FileStream($icoPath, [System.IO.FileMode]::Create)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]$images.Count)
$offset = 6 + 16 * $images.Count
foreach ($img in $images) {
  $b = $img.Bytes
  $dim = if ($img.Size -ge 256) { 0 } else { $img.Size }
  $bw.Write([Byte]$dim)
  $bw.Write([Byte]$dim)
  $bw.Write([Byte]0)
  $bw.Write([Byte]0)
  $bw.Write([UInt16]1)
  $bw.Write([UInt16]32)
  $bw.Write([UInt32]$b.Length)
  $bw.Write([UInt32]$offset)
  $offset += $b.Length
}
foreach ($img in $images) {
  [byte[]]$b = $img.Bytes
  $bw.Write($b)
}
$bw.Flush()
$bw.Dispose()
$fs.Dispose()

$fi = Get-Item $icoPath
"已生成 $($fi.FullName)  $([math]::Round($fi.Length/1KB,1)) KB"

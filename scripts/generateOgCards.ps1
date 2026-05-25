$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root "src\web\assets\og"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function New-Brush($hex) {
  return New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml($hex))
}

function New-Pen($hex, $width = 1) {
  return New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml($hex), $width)
}

function New-Font($family, $size, $style = [System.Drawing.FontStyle]::Regular) {
  return New-Object System.Drawing.Font($family, $size, $style, [System.Drawing.GraphicsUnit]::Pixel)
}

function Draw-RoundedRect($g, $brush, [float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  $g.FillPath($brush, $path)
  $path.Dispose()
}

function Draw-Text($g, $text, $font, $brush, [float]$x, [float]$y, [float]$w, [float]$h) {
  $format = New-Object System.Drawing.StringFormat
  $format.Trimming = [System.Drawing.StringTrimming]::EllipsisWord
  $format.FormatFlags = [System.Drawing.StringFormatFlags]::LineLimit
  $rect = New-Object System.Drawing.RectangleF($x, $y, $w, $h)
  $g.DrawString($text, $font, $brush, $rect, $format)
  $format.Dispose()
}

function Draw-Card($fileName, $kicker, $title, $subtitle, $primary, $secondary, $chips) {
  $bitmap = New-Object System.Drawing.Bitmap(1200, 630)
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

  $bg = New-Brush "#f6f3ec"
  $ink = New-Brush "#141414"
  $muted = New-Brush "#5f625d"
  $line = New-Pen "#d7d0c2" 1
  $primaryBrush = New-Brush $primary
  $secondaryBrush = New-Brush $secondary
  $panel = New-Brush "#fffdf8"
  $soft = New-Brush "#e8efe7"
  $dark = New-Brush "#1d2320"
  $white = New-Brush "#ffffff"

  $g.FillRectangle($bg, 0, 0, 1200, 630)
  for ($x = 56; $x -lt 1180; $x += 72) {
    $g.DrawLine($line, $x, 0, $x, 630)
  }
  for ($y = 46; $y -lt 630; $y += 72) {
    $g.DrawLine($line, 0, $y, 1200, $y)
  }

  Draw-RoundedRect $g $panel 54 54 1092 522 26
  Draw-RoundedRect $g $dark 820 94 270 382 24
  Draw-RoundedRect $g $primaryBrush 870 139 174 88 18
  Draw-RoundedRect $g $secondaryBrush 856 262 202 46 14
  Draw-RoundedRect $g $soft 858 334 174 24 12
  Draw-RoundedRect $g $soft 858 376 134 24 12
  Draw-RoundedRect $g $soft 858 418 192 24 12

  $trendPen = New-Pen $secondary 5
  $points = @(
    (New-Object System.Drawing.PointF(134, 468)),
    (New-Object System.Drawing.PointF(252, 428)),
    (New-Object System.Drawing.PointF(360, 444)),
    (New-Object System.Drawing.PointF(506, 362)),
    (New-Object System.Drawing.PointF(658, 392)),
    (New-Object System.Drawing.PointF(764, 318))
  )
  $g.DrawCurve($trendPen, [System.Drawing.PointF[]]$points, 0.28)
  foreach ($pt in $points) {
    $g.FillEllipse($primaryBrush, $pt.X - 7, $pt.Y - 7, 14, 14)
  }

  $brandFont = New-Font "Segoe UI" 34 ([System.Drawing.FontStyle]::Bold)
  $kickerFont = New-Font "Segoe UI" 28 ([System.Drawing.FontStyle]::Bold)
  $titleFont = New-Font "Segoe UI" 56 ([System.Drawing.FontStyle]::Bold)
  $subFont = New-Font "Segoe UI" 27 ([System.Drawing.FontStyle]::Regular)
  $chipFont = New-Font "Segoe UI" 22 ([System.Drawing.FontStyle]::Bold)

  $g.DrawString("baes scan", $brandFont, $ink, 94, 86)
  Draw-RoundedRect $g $primaryBrush 95 142 74 8 4
  Draw-RoundedRect $g $secondaryBrush 176 142 42 8 4
  $g.DrawString($kicker.ToUpperInvariant(), $kickerFont, $primaryBrush, 94, 174)
  Draw-Text $g $title $titleFont $ink 90 224 710 74
  Draw-Text $g $subtitle $subFont $muted 96 392 620 82

  $chipX = 94
  foreach ($chip in $chips) {
    $measure = $g.MeasureString($chip, $chipFont)
    $width = [Math]::Min(260, [Math]::Max(112, $measure.Width + 34))
    Draw-RoundedRect $g $dark $chipX 504 $width 42 18
    $g.DrawString($chip, $chipFont, $white, $chipX + 17, 511)
    $chipX += $width + 14
  }

  $monoFont = New-Font "Consolas" 21 ([System.Drawing.FontStyle]::Bold)
  $g.DrawString("raw RPC", $monoFont, $white, 920, 456)

  $path = Join-Path $outDir $fileName
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)

  $g.Dispose()
  $bitmap.Dispose()
}

Draw-Card "baes-scan.png" "Telegram buy alerts" "Raw DEX buy alerts" "Pool-aware Telegram alerts across real DEX routes, exact pools, topics, and launch channels." "#2f8f66" "#d09b2c" @("Uniswap v4", "Topics", "No private keys")
Draw-Card "baes-intel.png" "Holder intel" "Token-gated intel" "Review wallet PnL, New Tokens, overlap cohorts, risk signals, and early flow from the retained ledger." "#365fd8" "#c64f5c" @("New Tokens", "Wallet PnL", "Clusters")
Draw-Card "baes-guides.png" "Buybot guides" "DEX route guides" "Chain, protocol, and troubleshooting guides for pool-aware Telegram buy alerts." "#7a5c21" "#3b8b8c" @("Base", "Uniswap", "DEX alerts")

Write-Host "Generated OG cards in $outDir"

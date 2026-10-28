# 造两个测试视频：① 有中文口播（验本地转写） ② 有同名字幕（验 sidecar 路径）
# 用法：powershell -ExecutionPolicy Bypass -File tools\make-test-media.ps1 [-OutDir <目录>]
# ⚠️ 这个文件必须存成 **UTF-8 with BOM**：Windows PowerShell 5.1 读无 BOM 的 .ps1 会按 ANSI 解释，中文全乱。
param(
  [string]$OutDir = (Join-Path $env:TEMP 'video-distill-test'),
  [string]$Ffmpeg = ''
)
$ErrorActionPreference = 'Stop'
$dir = $OutDir
New-Item -ItemType Directory -Force -Path $dir | Out-Null

# ── ① 中文 TTS → wav ──
Add-Type -AssemblyName System.Speech
$text = '很多人拍视频第一天就踩坑，光顾着买相机，其实最重要的东西是前三秒。第一句话决定别人划不划走，第二句话决定他信不信你，第三句话才轮到你讲内容。所以别再花两个小时调色了，先花十分钟把开头写好。你上次拍视频，开头第一句是什么？'
$sp = New-Object System.Speech.Synthesis.SpeechSynthesizer
$sp.SelectVoice('Microsoft Huihui Desktop')
$sp.Rate = 1
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
  16000,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono)
$wav = Join-Path $dir 'narration.wav'
$sp.SetOutputToWaveFile($wav, $fmt)
$sp.Speak($text)
$sp.Dispose()
"wav: $((Get-Item $wav).Length) bytes"

# ── ② 把 wav 配上一段"三镜头竖屏画面" → spoken.mp4 ──
$ff = if ($Ffmpeg) { $Ffmpeg } else { (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source }
if (-not $ff) { throw 'PATH 里没有 ffmpeg。请先装 ffmpeg，或用 -Ffmpeg <ffmpeg.exe 绝对路径> 指过去。' }
$mp4 = Join-Path $dir 'spoken.mp4'
& $ff -y -loglevel error `
  -f lavfi -i 'color=c=0x1f2937:s=1080x1920:r=30:d=6' `
  -f lavfi -i 'color=c=0x9f1239:s=1080x1920:r=30:d=6' `
  -f lavfi -i 'color=c=0x14532d:s=1080x1920:r=30:d=8' `
  -i $wav `
  -filter_complex '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]' `
  -map '[v]' -map 3:a -shortest -c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p -c:a aac -b:a 96k $mp4
"mp4: $((Get-Item $mp4).Length) bytes"

# ── ③ 无声短片 + 同名字幕（验 sidecar，不需要任何 ASR） ──
$ff2 = Join-Path $dir 'subtitled.mp4'
& $ff -y -loglevel error `
  -f lavfi -i 'color=c=0x0f172a:s=1080x1920:r=30:d=8' `
  -f lavfi -i 'color=c=0x7c2d12:s=1080x1920:r=30:d=8' `
  -filter_complex '[0:v][1:v]concat=n=2:v=1:a=0[v]' `
  -map '[v]' -c:v libx264 -preset veryfast -crf 30 -pix_fmt yuv420p $ff2
"mp4: $((Get-Item $ff2).Length) bytes"

$srtLines = @(
  '1',
  '00:00:00,200 --> 00:00:02,800',
  '你以为剪辑难，其实难的是选对第一句话。',
  '',
  '2',
  '00:00:03,000 --> 00:00:06,500',
  '这条视频我只讲一个动作：把结论搬到最前面。',
  '',
  '3',
  '00:00:06,800 --> 00:00:10,000',
  '下次写脚本，先写最后一句，再倒着写开头。',
  ''
)
Set-Content -Path (Join-Path $dir 'subtitled.srt') -Value ($srtLines -join "`r`n") -Encoding UTF8

Get-ChildItem $dir | Select-Object Name, Length | Format-Table -AutoSize

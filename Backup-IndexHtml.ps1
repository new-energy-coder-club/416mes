# Backup-IndexHtml.ps1 — 改界面前先双击运行
# 把 index.html 复制成 backups/index-YYYYMMDD-HHMMSS.html，只留最新 20 份。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$src  = Join-Path $root 'index.html'
$dir  = Join-Path $root 'backups'

if (-not (Test-Path $src)) { Write-Error "找不到 $src"; exit 1 }
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dst   = Join-Path $dir "index-$stamp.html"
Copy-Item $src $dst
Write-Host "已备份: $dst"

# 只留最新 20 份
$old = Get-ChildItem $dir -Filter 'index-*.html' |
       Sort-Object LastWriteTime -Descending |
       Select-Object -Skip 20
$old | Remove-Item -Force
if ($old) { Write-Host "已清理 $($old.Count) 份旧备份" }

[CmdletBinding()]
param(
  [string]$PiHome = (Join-Path $env:USERPROFILE '.pi\agent')
)

# 比对 ~/.pi/agent/extensions 下与 manifest/extensions.sha256.json 的基线哈希。
# 退出码 0 = 全一致；2 = 有漂移/缺失。

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$baseFile = Join-Path $repo 'manifest\extensions.sha256.json'
if (-not (Test-Path $baseFile)) { Write-Error "缺少 $baseFile"; exit 2 }
$base = Get-Content $baseFile -Raw | ConvertFrom-Json

$bad = 0
foreach ($prop in $base.files.PSObject.Properties) {
  $name = $prop.Name
  $want = $prop.Value
  $path = Join-Path $PiHome "extensions\$name"
  if (-not (Test-Path $path)) {
    Write-Host "[MISS] $name —— 未安装" -ForegroundColor Yellow
    $bad++
    continue
  }
  $got = (Get-FileHash $path -Algorithm SHA256).Hash.ToLower()
  if ($got -eq $want) {
    Write-Host "[ OK ] $name  $got" -ForegroundColor Green
  } else {
    Write-Host "[DIFF] $name" -ForegroundColor Red
    Write-Host "       local : $got"
    Write-Host "       base  : $want"
    $src = $base.repo_sources.$name
    if ($src) { Write-Host "       repo  : $src" }
    $bad++
  }
}
Write-Host ''
if ($bad -eq 0) { Write-Host 'All files match the baseline.' -ForegroundColor Green; exit 0 }
Write-Host "$bad item(s) differ. Fix: re-run 'pi install git:github.com/gthubtom1/agent-plugins@main', then re-run this script." -ForegroundColor Yellow
exit 2
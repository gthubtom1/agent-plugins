<#
.SYNOPSIS
  重新生成 manifest/extensions.sha256.json —— 扩展哈希基线。
.DESCRIPTION
  基线的语义是「仓库里现在有什么」，哈希取自**仓库源文件**，不是本机安装的那份。
  这样 check-sync.ps1 才是真正的对账：本机 == 仓库 == 基线。

  之前没有这个脚本，基线是手改的，结果里面躺着 3 个 orca-* 文件 ——
  仓库里没有、本机也没装，换机也复现不出来，于是 check-sync 永远报 MISSING。
  「改了插件忘了重算」和「基线写了不存在的东西」是同一个病，所以给一条命令。

  收录规则（刻意保持简单，可预测）：
    扫 plugins/<宿主>/*/ 下的 *.ts、*.rules.json、smoke-*.mjs
    *.rules.*.json 变体模板（VM 版等）不收 —— 那是给人复制用的，不是要装到机器上的
    目录里有 RETIRED 文件的整个跳过（保留参考但不该装到机器上的插件）

.PARAMETER PiHome
  本机 pi 家目录。给了就连「仓库 vs 本机」一起核对，不一致直接报错（退出码 2）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\regen-extension-baseline.ps1
  powershell -ExecutionPolicy Bypass -File scripts\regen-extension-baseline.ps1 -PiHome $env:USERPROFILE\.pi\agent
#>
[CmdletBinding()]
param(
  [string]$PiHome = ''
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$out  = Join-Path $repo 'manifest\extensions.sha256.json'

$files   = [ordered]@{}
$sources = [ordered]@{}

$hostDirs = Get-ChildItem (Join-Path $repo 'plugins') -Directory
foreach ($h in $hostDirs) {
  $pluginDirs = Get-ChildItem $h.FullName -Directory
  foreach ($dir in $pluginDirs) {
    if (Test-Path (Join-Path $dir.FullName 'RETIRED')) {
      Write-Host "  [skip] $($h.Name)/$($dir.Name) —— 已标记 RETIRED" -ForegroundColor DarkGray
      continue
    }
    $candidates = Get-ChildItem $dir.FullName -File | Where-Object {
      # 只收「装到机器上」的文件
      $_.Name -like '*.ts' -or $_.Name -like '*.rules.json' -or $_.Name -like 'smoke-*.mjs'
    }
    foreach ($f in $candidates) {
      $name = $f.Name
      $files[$name]   = (Get-FileHash $f.FullName -Algorithm SHA256).Hash.ToLower()
      $sources[$name] = "plugins/$($h.Name)/$($dir.Name)/$name"
      Write-Host "  [ ok ] $name  $($files[$name])" -ForegroundColor Green
    }
  }
}

if ($files.Count -eq 0) { Write-Error "一个扩展都没扫到，检查 plugins\ 目录结构"; exit 2 }

$obj = [ordered]@{
  generated_from = 'plugins/**  (仓库源文件，不是本机安装的那份)'
  regenerate_with = 'scripts/regen-extension-baseline.ps1'
  files           = $files
  repo_sources    = $sources
}
$json = $obj | ConvertTo-Json -Depth 5
# UTF8 无 BOM：BOM 会让一部分 JSON 解析器直接报错（936 代码页的机器上尤其常见）
[System.IO.File]::WriteAllText($out, $json + "`n", (New-Object System.Text.UTF8Encoding $false))
Write-Host "`n基线已写入 $out（$($files.Count) 项）" -ForegroundColor Cyan

# 可选：顺带核对本机
if (-not $PiHome) { exit 0 }

$bad = 0
foreach ($k in $files.Keys) {
  $p = Join-Path $PiHome "extensions\$k"
  if (-not (Test-Path $p)) {
    Write-Host "[MISS] $k 未安装" -ForegroundColor Yellow; $bad++; continue
  }
  $got = (Get-FileHash $p -Algorithm SHA256).Hash.ToLower()
  if ($got -eq $files[$k]) { Write-Host "[ OK ] $k" -ForegroundColor Green }
  else { Write-Host "[DIFF] $k  本机与仓库不一致" -ForegroundColor Red; $bad++ }
}
if ($bad) {
  Write-Host "`n$bad 项与仓库不一致 —— 先把 plugins\ 里的文件复制到本机 extensions\ 再重跑" -ForegroundColor Yellow
  exit 2
}
exit 0
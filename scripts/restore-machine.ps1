<#
.SYNOPSIS
  换机恢复本机 Pi Agent 环境（幂等，可重复执行）。
.DESCRIPTION
  依据 docs/ENV-MANIFEST.md：
    1. 装 pi 本体、9 个第三方 npm 包、自制扩展包（git:github.com/gthubtom1/agent-plugins@main）
    2. 用 manifest/ 里的脱敏模板覆盖 ~/.pi/agent/*.json（先自动备份原文件）
    3. 恢复 ~/.agents/skills（仓内备份）与 ~/.agents/servers
    4. 打印 pi list 与扩展哈希对账结果
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\restore-machine.ps1 -ToolRoot 'D:\Tools' -PyRoot 'D:\Tools\py' -NewApiKey 'sk-…' -X64dbgToken '…'
  # 不传 -ToolRoot / -PyRoot 时按 REVERSE_TOOL_ROOT / REVERSE_PY_ROOT 环境变量取，都没有才用上面的默认值
#>
[CmdletBinding()]
param(
  # pi 主目录（默认 $env:USERPROFILE\.pi\agent）
  [string]$PiHome = (Join-Path $env:USERPROFILE '.pi\agent'),
  # 逆向工具根（IDA / x64dbg / jadx / DIE…）。换盘设 REVERSE_TOOL_ROOT，别改脚本。
  [string]$ToolRoot = $(if ($env:REVERSE_TOOL_ROOT) { $env:REVERSE_TOOL_ROOT } else { 'D:\Tools' }),
  # Python 根（idalib-mcp.exe 在 Scripts 下）
  [string]$PyRoot = $(if ($env:REVERSE_PY_ROOT) { $env:REVERSE_PY_ROOT } else { 'D:\Tools\py' }),
  # newapi provider 的 API key（写回 models.json + auth.json）
  [string]$NewApiKey = '',
  # x64dbg / x64dbg32 的 MCP Bearer token（来自 release\x64\mcp_config.json）
  [string]$X64dbgToken = '',
  # 共享技能目录（Orca 用），默认 $env:USERPROFILE\.agents
  [string]$AgentsHome = (Join-Path $env:USERPROFILE '.agents'),
  # 只做配置恢复，跳过 pi / npm 安装
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Manifest = Join-Path $RepoRoot 'manifest'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    [ok] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    [!!] $msg" -ForegroundColor Yellow }

function Backup-IfExists($path) {
  if (Test-Path $path) {
    Copy-Item $path "$path.bak-$stamp" -Force
    Write-Ok "备份 $path -> $(Split-Path -Leaf "$path.bak-$stamp")"
  }
}

# 把 manifest 模板里的占位符换成真实值
# 注意：模板里路径分隔符写成 \\（JSON 转义），所以替换值本身不能含反斜杠，
# 否则渲染出 "\E" 这类非法转义 —— 这里统一转成正斜杠，Windows 同样认。
function Expand-Template([string]$text) {
  $tool = $ToolRoot -replace '\\', '/'
  $py = $PyRoot -replace '\\', '/'
  $text = $text.Replace('${TOOL_ROOT}', $tool)
  $text = $text.Replace('${PY_ROOT}', $py)
  $text = $text.Replace('${X64DBG_MCP_TOKEN}', $X64dbgToken)
  $text = $text.Replace('${NEWAPI_API_KEY}', $NewApiKey)
  return $text
}

function Install-PiPackages {
  Write-Step '安装 pi 本体与插件包'
  if (-not (Get-Command pi -ErrorAction SilentlyContinue)) {
    Write-Ok 'npm i -g @earendil-works/pi-coding-agent@1.0.0'
    npm i -g @earendil-works/pi-coding-agent@1.0.0
  } else { Write-Ok 'pi 已在 PATH，跳过本体安装' }

  # 自制插件包（含 cmd-guard / retry-level），幂等：已存在则先 remove 再装
  if (-not (Get-Command pi -ErrorAction SilentlyContinue)) {
    Write-Warn 'pi 不可用，跳过 pi install；可稍后手动执行下方命令'
    return
  }
  pi list | Out-String | Write-Host

  $pkgs = @(
    'npm:pi-plan-task@5.0.7',
    'npm:@demigodmode/pi-web-agent@1.14.0',
    'npm:@aaronkyriesenbach/pi-package-manager@0.5.0',
    'npm:pi-open-tui@0.3.11',
    'npm:pi-web-access@0.35.0',
    'npm:pi-mcp-adapter@5.0.0',
    'npm:pi-tool-display@0.5.0',
    'npm:pi-win-notify@1.0.15',
    'npm:@gotgenes/pi-subagents@22.0.0',
    'git:github.com/gthubtom1/agent-plugins@main'
  )
  foreach ($p in $pkgs) {
    Write-Ok "pi install $p"
    pi install $p
  }
}

function Restore-PiConfigs {
  Write-Step "恢复 pi 配置到 $PiHome"
  New-Item -ItemType Directory -Force -Path $PiHome | Out-Null

  $files = @('pi-settings.json', 'mcp.json', 'models.json', 'open-tui.json',
             'web-search.json', 'keybindings.json', 'trust.json')
  $map = @{
    'pi-settings.json' = 'settings.json'
    'mcp.json'         = 'mcp.json'
    'models.json'      = 'models.json'
    'open-tui.json'    = 'open-tui.json'
    'web-search.json'  = 'web-search.json'
    'keybindings.json' = 'keybindings.json'
    'trust.json'       = 'trust.json'
  }
  foreach ($f in $files) {
    $src = Join-Path $Manifest $f
    if (-not (Test-Path $src)) { Write-Warn "缺少模板 $f，跳过"; continue }
    $dst = Join-Path $PiHome $map[$f]
    Backup-IfExists $dst
    # 模板与落盘一律显式 UTF-8（PS 5.1 默认按 ANSI 读会毁掉中文并把 \ 吃成 GBK 双字节）
    $rendered = Expand-Template (Get-Content $src -Raw -Encoding UTF8)
    $null = $rendered | ConvertFrom-Json          # JSON 校验通过才落盘
    [System.IO.File]::WriteAllText($dst, $rendered, (New-Object System.Text.UTF8Encoding $false))
    Write-Ok "写入 $(Split-Path -Leaf $dst)"
  }

  if ($NewApiKey) {
    $auth = @{ newapi = @{ type = 'api_key'; key = $NewApiKey } } | ConvertTo-Json
    Backup-IfExists (Join-Path $PiHome 'auth.json')
    [System.IO.File]::WriteAllText((Join-Path $PiHome 'auth.json'), $auth + "`n", (New-Object System.Text.UTF8Encoding $false))
    Write-Ok '写入 auth.json（newapi key）'
  } else {
    Write-Warn '未提供 -NewApiKey：请手工把 key 写进 models.json 的 providers.newapi.apiKey'
  }
  if (-not $X64dbgToken) {
    Write-Warn '未提供 -X64dbgToken：mcp.json 中 x64dbg / x64dbg32 的 Authorization 仍是占位符，请从 release\x64\mcp_config.json 取值替换'
  }
}

function Restore-AgentsAssets {
  Write-Step "恢复共享技能与 MCP server 定义到 $AgentsHome"
  $skillSrc = Join-Path $Manifest 'skills'
  if (Test-Path $skillSrc) {
    foreach ($d in Get-ChildItem -Directory $skillSrc) {
      $dst = Join-Path $AgentsHome "skills\$($d.Name)"
      New-Item -ItemType Directory -Force -Path $dst | Out-Null
      Copy-Item (Join-Path $d.FullName '*') $dst -Force
      Write-Ok "skill $($d.Name)"
    }
  }
  $srvFile = Join-Path $Manifest 'agent-servers.json'
  if (Test-Path $srvFile) {
    $serversDir = Join-Path $AgentsHome 'servers'
    New-Item -ItemType Directory -Force -Path $serversDir | Out-Null
    # 用 helper 脚本拆分并以 UTF-8(无 BOM) 落盘，避免 PS 5.1 的 JSON 转义与编码坑
    & node (Join-Path $PSScriptRoot 'split-servers.js') $srvFile $serversDir
    if ($LASTEXITCODE -ne 0) { Write-Warn 'agent-servers.json 拆分失败，请手工拷贝 manifest/agent-servers.json 中每项为 <id>.json' }
  }
}

function Show-Verify {
  Write-Step '对账：扩展哈希'
  & (Join-Path $PSScriptRoot 'check-sync.ps1') -PiHome $PiHome
}

# ---------- 主流程 ----------
Write-Host ''
Write-Host '=== restore-machine.ps1 ===' -ForegroundColor Green
if (-not $SkipInstall) { Install-PiPackages }
Restore-PiConfigs
Restore-AgentsAssets
Show-Verify
Write-Host ''
Write-Host '完成。重启 pi 后用 /guard status 与 pi list 验证。' -ForegroundColor Green
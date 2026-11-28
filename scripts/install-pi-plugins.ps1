<#
.SYNOPSIS
    以「短名」方式把本仓库的 Pi 插件安装到 ~/.pi/agent。

.DESCRIPTION
    为什么需要这个脚本：

    `pi install <path>` 会把来源路径写进 settings.json 的 packages 数组，
    而 pi-web / `pi list` 直接显示这个字符串。

      - 用相对路径安装  -> 写入 "plugins\pi\lab" 这类相对路径，
                          从别的目录再装就变成 "plugin-src\agent-plugins\..." 长串
      - 用绝对路径安装  -> Pi 会把它规范成「相对 agentDir 的路径」，仍然是长串
      - 在 agentDir 下建同名的目录联接（Junction），再按名字安装
                        -> 写入的就是干净的短名，例如 "pi-lab"

    本脚本采用第三种方式：在 <agentDir> 下建立 Junction 指向仓库里的插件目录，
    然后按短名安装。插件升级只需在仓库里 git pull，Junction 不需要重建。

.PARAMETER Plugins
    要安装的插件短名，默认安装全部 Pi 插件。可用 -Plugins pi-lab,pi-remote 只装部分。

.PARAMETER AgentDir
    Pi 的 agent 目录，默认 ~/.pi/agent。DSH 或其他宿主请显式指定。

.PARAMETER List
    只列出可用插件与当前安装状态，不做任何修改。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\install-pi-plugins.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\install-pi-plugins.ps1 -Plugins pi-cmd-guard,pi-retry-level

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\install-pi-plugins.ps1 -List
#>
[CmdletBinding()]
param(
    [string[]] $Plugins,
    [string]   $AgentDir,
    [switch]   $List
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$piSource = Join-Path $repoRoot 'plugins\pi'

if (-not (Test-Path $piSource)) {
    throw "Pi plugin directory not found: $piSource"
}

if (-not $AgentDir) {
    $AgentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $HOME '.pi\agent' }
}
$AgentDir = [System.IO.Path]::GetFullPath($AgentDir)

# 目录名 -> 安装短名。persona 与 persona-old 都注册 /persona，只能启用其中一个。
$catalog = [ordered]@{
    'cmd-guard'   = 'pi-cmd-guard'
    'retry-level' = 'pi-retry-level'
    'remote'      = 'pi-remote'
    'lab'         = 'pi-lab'
    'persona'     = 'pi-persona'
    'rewind'      = 'pi-rewind'
    'persona-old' = 'pi-persona-old'
}

# 默认不装 persona（新版），因为多数用法是与 persona-old 二选一；
# 两个都装会让 /persona 冲突。想装新版请显式 -Plugins pi-persona。
$defaultPlugins = @(
    'pi-cmd-guard',
    'pi-retry-level',
    'pi-remote',
    'pi-lab',
    'pi-rewind'
)

$nameToDir = @{}
foreach ($k in $catalog.Keys) { $nameToDir[$catalog[$k]] = $k }

function Get-InstalledSources {
    param([string] $SettingsPath)
    if (-not (Test-Path $SettingsPath)) { return @() }
    try {
        $json = Get-Content $SettingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    catch {
        Write-Warning "Cannot parse ${SettingsPath}: $($_.Exception.Message)"
        return @()
    }
    if (-not $json.packages) { return @() }
    return @($json.packages | ForEach-Object {
        if ($_ -is [string]) { $_ } else { $_.source }
    } | Where-Object { $_ })
}

$settingsPath = Join-Path $AgentDir 'settings.json'
$installed = Get-InstalledSources -SettingsPath $settingsPath

if ($List) {
    Write-Host "agentDir: $AgentDir"
    Write-Host ''
    Write-Host ('{0,-18} {1,-14} {2}' -f 'NAME', 'SOURCE', 'STATE')
    Write-Host ('{0,-18} {1,-14} {2}' -f '--------', '------', '----')
    foreach ($k in $catalog.Keys) {
        $name   = $catalog[$k]
        $link   = Join-Path $AgentDir $name
        $target = Join-Path $piSource $k
        $linked = Test-Path $link
        $inSet  = $installed -contains $name
        $state  = if ($inSet -and $linked) { 'installed' }
                  elseif ($inSet)          { 'registered, junction missing' }
                  elseif ($linked)         { 'junction only, not registered' }
                  else                     { 'not installed' }
        Write-Host ('{0,-18} {1,-14} {2}' -f $name, $k, $state)
    }
    Write-Host ''
    $legacy = $installed | Where-Object { $_ -match '\\' -or $_ -match '/plugins/' }
    if ($legacy) {
        Write-Host 'Long-path entries found (should be short names):' -ForegroundColor Yellow
        $legacy | ForEach-Object { Write-Host "  $_" }
    }
    return
}

if (-not $Plugins -or $Plugins.Count -eq 0) {
    $Plugins = $defaultPlugins
}

foreach ($name in $Plugins) {
    if (-not $nameToDir.ContainsKey($name)) {
        throw "Unknown plugin name: $name. Available: $($catalog.Values -join ', ')"
    }
}
if (($Plugins -contains 'pi-persona') -and ($Plugins -contains 'pi-persona-old')) {
    throw 'pi-persona and pi-persona-old both register /persona. Pick only one.'
}

if (-not (Test-Path $AgentDir)) {
    New-Item -ItemType Directory -Path $AgentDir -Force | Out-Null
}

# 先清掉指向同一插件目录的长路径旧条目，避免同一插件被加载两次。
$toRemove = @()
foreach ($entry in $installed) {
    # Registry/git sources can contain slashes but are not filesystem paths.
    if ($entry -match '^(npm|git|github|https?|ssh|builtin):') { continue }
    if ($entry -match '\\' -or $entry -match '/') {
        $resolved = if ([System.IO.Path]::IsPathRooted($entry)) { $entry } else { Join-Path $AgentDir $entry }
        foreach ($name in $Plugins) {
            $target = Join-Path $piSource $nameToDir[$name]
            if ([System.IO.Path]::GetFullPath($resolved).TrimEnd('\') -ieq $target.TrimEnd('\')) {
                $toRemove += $entry
            }
        }
    }
}

$pi = Get-Command pi -ErrorAction SilentlyContinue
if (-not $pi) {
    throw 'pi command not found. Install Pi Coding Agent and make sure it is on PATH.'
}

# pi install reads the agent dir from PI_CODING_AGENT_DIR, so -AgentDir must reach
# the child process too. Otherwise the junctions land in the chosen dir while the
# package entries are written to the default profile.
$previousAgentDir = $env:PI_CODING_AGENT_DIR
$env:PI_CODING_AGENT_DIR = $AgentDir

foreach ($name in $Plugins) {
    $dir    = $nameToDir[$name]
    $target = Join-Path $piSource $dir
    $link   = Join-Path $AgentDir $name

    if (-not (Test-Path $target)) {
        Write-Warning "Skip ${name}: source not found at $target"
        continue
    }

    if (Test-Path $link) {
        $item = Get-Item $link -Force
        if ($item.LinkType -in @('Junction', 'SymbolicLink')) {
            $current = @($item.Target)[0]
            if ($current -and ([System.IO.Path]::GetFullPath($current).TrimEnd('\') -ine $target.TrimEnd('\'))) {
                Write-Host "Rebuild junction: $name -> $target"
                Remove-Item $link -Force
                New-Item -ItemType Junction -Path $link -Target $target | Out-Null
            }
            else {
                Write-Host "Junction ready: $name"
            }
        }
        else {
            Write-Warning "Skip ${name}: $link exists and is not a link."
            continue
        }
    }
    else {
        New-Item -ItemType Junction -Path $link -Target $target | Out-Null
        Write-Host "Create junction: $name -> $target"
    }
}

foreach ($entry in ($toRemove | Select-Object -Unique)) {
    & pi remove $entry 2>&1 | Out-Null
    Write-Host "Remove long-path entry: $entry"
}

foreach ($name in $Plugins) {
    $link = Join-Path $AgentDir $name
    if (-not (Test-Path $link)) { continue }
    # Pass the absolute path so Pi normalizes it to a path relative to agentDir,
    # which is exactly the short name written to settings.json.
    & pi install $link 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Installation failed: $name (exit $LASTEXITCODE)."
    }
    if ($name -eq 'pi-remote') {
        & (Join-Path $PSScriptRoot 'configure-pi-web.ps1')
    }
    Write-Host "Installed: $name"
}

if ($null -eq $previousAgentDir) { Remove-Item Env:PI_CODING_AGENT_DIR -ErrorAction SilentlyContinue }
else { $env:PI_CODING_AGENT_DIR = $previousAgentDir }

Write-Host ''
Write-Host 'Done. Reopen the Pi session, or run /reload in an existing one.' -ForegroundColor Green
Write-Host "Configured packages:"
$final = Get-InstalledSources -SettingsPath $settingsPath
$final | ForEach-Object { Write-Host "  $_" }

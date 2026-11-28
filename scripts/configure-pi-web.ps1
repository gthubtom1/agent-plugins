<#
.SYNOPSIS
    Persist pi-web's all-interface listener for normal future pi-web launches.
.DESCRIPTION
    Does not restart a running server or change passwords, firewall rules or routing.
    May also be run on its own to repair an existing pi-remote installation.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# User environment alone is insufficient when an existing terminal application
# keeps passing its old environment to new tabs. Refresh both PowerShell profiles.
[Environment]::SetEnvironmentVariable('PI_WEB_HOSTNAME', '0.0.0.0', 'User')
$env:PI_WEB_HOSTNAME = '0.0.0.0'
$profileLine = '$env:PI_WEB_HOSTNAME = [Environment]::GetEnvironmentVariable(''PI_WEB_HOSTNAME'', ''User'') # pi-remote'
$documents = [Environment]::GetFolderPath('MyDocuments')
$profilePaths = @(
    (Join-Path $documents 'WindowsPowerShell\profile.ps1'),
    (Join-Path $documents 'PowerShell\profile.ps1'),
    $PROFILE.CurrentUserAllHosts
) | Select-Object -Unique

foreach ($profilePath in $profilePaths) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $profilePath) -Force | Out-Null
    if (!(Test-Path -LiteralPath $profilePath) -or
        (Get-Content -LiteralPath $profilePath -Encoding UTF8) -notcontains $profileLine) {
        Add-Content -LiteralPath $profilePath -Encoding UTF8 -Value @('', $profileLine)
    }
}

. (Join-Path $PSScriptRoot 'pi-web-launchers.ps1')
$launchers = @(Get-Command pi-web.ps1, pi-web.cmd -All -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty Source -Unique)
foreach ($launcher in $launchers) {
    Update-PiWebLauncher -Path $launcher
    Write-Host "pi-web launch configuration ready: $launcher"
}
if (!$launchers.Count) {
    Write-Warning 'pi-web launchers not found. Run this configuration again after installing pi-web.'
}

Write-Host 'pi-web: PI_WEB_HOSTNAME=0.0.0.0 saved for this Windows user and both PowerShell editions.'
Write-Host 'Restart pi-web to apply, including in the current terminal. LAN and Tailscale still require a reachable network path.'

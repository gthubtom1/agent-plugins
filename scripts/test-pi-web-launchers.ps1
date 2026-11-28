$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'pi-web-launchers.ps1')

$testDir = Join-Path ([IO.Path]::GetTempPath()) ('pi-web-launcher-test-' + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $testDir | Out-Null
$oldHostname = $env:PI_WEB_HOSTNAME
try {
    $savedHostname = [Environment]::GetEnvironmentVariable('PI_WEB_HOSTNAME', 'User')
    if (!$savedHostname) { throw 'Configure a user hostname before running this Windows integration test.' }
    $ps = Join-Path $testDir 'pi-web.ps1'
    $cmd = Join-Path $testDir 'pi-web.cmd'
    [IO.File]::WriteAllText($ps, "#!/usr/bin/env pwsh`nWrite-Output (`$env:PI_WEB_HOSTNAME + '|' + (`$args -join ','))`n")
    [IO.File]::WriteAllText($cmd, "@echo off`r`necho %PI_WEB_HOSTNAME%^|%*`r`n")
    foreach ($path in @($ps, $cmd)) {
        $before = [IO.File]::ReadAllText($path)
        Update-PiWebLauncher -Path $path
        $once = [IO.File]::ReadAllText($path)
        Update-PiWebLauncher -Path $path
        if ([IO.File]::ReadAllText($path) -cne $once) { throw "Non-idempotent patch: $path" }
        if ([IO.File]::ReadAllText("$path.pi-remote.bak") -cne $before) { throw "Backup mismatch: $path" }
    }
    $env:PI_WEB_HOSTNAME = '127.0.0.1'
    $actual = & powershell.exe -NoProfile -File $ps --hostname localhost
    if ($LASTEXITCODE -ne 0 -or $actual -ne "$savedHostname|--hostname,localhost") {
        throw "PowerShell stale environment regression: $actual"
    }
    $actual = & $cmd --hostname localhost
    if ($LASTEXITCODE -ne 0 -or $actual -ne "$savedHostname|--hostname localhost") {
        throw "CMD stale environment regression: $actual"
    }
    Write-Output 'PASS: PowerShell and CMD refresh stale environments, preserve CLI arguments, keep backups and are idempotent.'
} finally {
    $env:PI_WEB_HOSTNAME = $oldHostname
    Remove-Item -LiteralPath $testDir -Recurse -Force
}

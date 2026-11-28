# Refresh the saved user setting on every launch, including launches from an
# already-open terminal. CLI --hostname still takes precedence in pi-web.
function Update-PiWebLauncher {
    param([Parameter(Mandatory)][string] $Path)

    $content = [IO.File]::ReadAllText($Path)
    $marker = 'pi-remote: refresh saved hostname'
    if ($content.Contains($marker)) { return }
    $newline = if ($content.Contains("`r`n")) { "`r`n" } else { "`n" }

    switch ([IO.Path]::GetExtension($Path)) {
        '.ps1' {
            $hook = @'
# pi-remote: refresh saved hostname
$piRemoteHostname = [Environment]::GetEnvironmentVariable('PI_WEB_HOSTNAME', 'User')
if ($piRemoteHostname) { $env:PI_WEB_HOSTNAME = $piRemoteHostname }
'@
            # Preserve npm's shebang, if present.
            $offset = if ($content.StartsWith('#!')) { $content.IndexOf("`n") + 1 } else { 0 }
            if ($offset -eq 0 -and $content.StartsWith('#!')) { throw "Invalid launcher: $Path" }
            $updated = $content.Insert($offset, ($hook -replace "`r?`n", $newline) + $newline)
        }
        '.cmd' {
            $hook = @'
@rem pi-remote: refresh saved hostname
@for /f "tokens=2,*" %%A in ('reg query "HKCU\Environment" /v PI_WEB_HOSTNAME 2^>nul') do @if /i "%%A"=="REG_SZ" set "PI_WEB_HOSTNAME=%%B"
'@
            $updated = ($hook -replace "`r?`n", $newline) + $newline + $content
        }
        default { throw "Unsupported launcher: $Path" }
    }

    # Keep the first unmodified launcher for recovery. npm may regenerate its
    # shims on update; re-running the installer reapplies this small hook.
    $backup = "$Path.pi-remote.bak"
    if (!(Test-Path -LiteralPath $backup)) { [IO.File]::WriteAllText($backup, $content, [Text.UTF8Encoding]::new($false)) }
    [IO.File]::WriteAllText($Path, $updated, [Text.UTF8Encoding]::new($false))
}

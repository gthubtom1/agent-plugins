# Changelog

## 0.1.0 — 2026-11-07

First cut: pure policy library plus command corpus. Runtime wiring exists but is not yet validated against a real SDK.

- Timeout classes (fast 60 / default 120 / heavy 900) with explicit-value clamping to a 1800 s ceiling.
- Whole-disk search rejection for find, grep -r, rg, du, tree, dir /s, Get-ChildItem -Recurse and where /R, including Git Bash drive paths (`/c`, `/d`).
- Tiered delete policy (T0 allow, T1 allow+note, T2 confirm, T3 block) covering rm, del, erase, rd, rmdir, Remove-Item, git clean, find -delete, xargs rm and inline rmtree/rmSync.
- Non-returning command detection: bare REPLs, stdin filters, pagers/editors, adb logcat/wait-for-device, frida, http.server, dev servers, ssh/sudo.
- Background command check: `cmd &` without redirecting stdout/stderr and closing stdin is refused.
- Everything CLI helpers (argument building, JSON parsing) for the planned `search_files` tool.
- 20 offline tests over a command corpus including the original failing `find /` command.

### Live host fix (0.1.0)

- Settings were read through an undocumented field, so `shellGuard.everything.esPath` never applied and `search_files` always reported "not configured". Now uses the documented `pi.getSettings()`, with `PI_SHELL_GUARD_ES` as an override.

### SDK verification and search_files (0.1.0)

- `scripts/verify-sdk.mjs`: real Pi SDK + deterministic in-process provider; 15 checks covering blocked whole-disk search, blocked drive-root delete, blocked bare REPL, allowed command with injected 60 s timeout, unnamed delete refused and not executed, user-named delete executed, grant not widening to a second path, and a live `search_files` query.
- `search_files` tool (Everything/es.exe): bounded results, explicit failure when the CLI or index is unavailable.
- New rule: an unquoted Windows path in a delete command is refused with a hint, because Git Bash strips the backslashes and `rm -f` then silently deletes nothing.

### Deletion grants (0.1.0)

- Reading the user's own turn: a delete verb plus a named path authorises that path for the current turn only, so an explicit request deletes without a prompt.
- Scope cannot be widened: every target must be covered by a user-named path; extra targets, globs, indirect deletes and inline script deletes still go to confirmation.
- T3 (drive root, home root, system directories) is never grantable.
- Junction/symlink targets are judged by their real path.

# Changelog

## 0.2.0 — 2026-11-08

Corrective review before frozen installer deployment. v0.1.0's reported replay classifications did not establish complete authorization enforcement.

- Separate the host entry from a testable runtime; use raw direct input provenance for narrow affirmative deletion grants, clear it across lifecycle boundaries, and require explicit bounded confirmation for uncertainty.
- Block the shell call when assessment or UI handling fails. Enforce the calculated timeout on explicit inputs too, rather than only calculating a clamp that never reached execution.
- Review cwd changes, wrapper options, multiple/implicit search roots, quoting/heredoc boundaries, protected ancestors and per-job stdout/stderr redirection. Stop automatically granting arbitrary project or system-temp trees and dynamic scripted deletes.
- Validate Everything query arguments and JSON strictly; cap process/output/result size, support abort, and state that index gaps or limited results are not proof of absence.
- Add `/shell-guard status` and read-only `/shell-guard check <command>` for observing the loaded version/path and dry policy decisions.
- Replace negative SDK smoke commands with inert execution recorders, using real SDK preflight and nested-tool events. Destructive/whole-disk candidates are never spawned by the verifier.
- Publish and install only this child package; no Pi-core patch or hub-wide activation. The adapter is a heuristic guard, not an OS sandbox. Future Pi versions require compatibility verification.

## 0.1.0 — 2026-11-07 (historical trial)

The notes below describe incremental trial stages. Initial test/replay counts are historical, not guarantees, and some preliminary status sentences were superseded before release.

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

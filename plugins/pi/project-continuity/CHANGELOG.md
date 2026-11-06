# Changelog

## [1.1.0] — 2026-11-06

- Detached HEAD records now carry the exact commit identity.
- Technical records in Reverse cases require case and target identity; unknown or mismatched target records stay out of current recovery.
- Cancelled decisions are terminal; normalized ID and alias collisions fail closed; historical titles remain searchable.
- Stale technical evidence is shown as needs-review with its old body withheld from recovery.
- Tool failures pair start/end events by call id and preserve parallel failures independently.

## [1.0.0] — 2026-11-06

- Project-local source-linked continuity records and bounded recovery.
- Revisions, cancelled decisions, historical aliases, stale-source reporting and conditional failed attempts.
- Pi status/search/save tools, lifecycle recovery and candidate-only session narration.
- Independent package; no database, external memory service, background model, new approval gate or forced continuation.

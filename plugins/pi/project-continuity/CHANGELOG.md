# Changelog

## [1.2.0] — 2026-11-07

- Replaced unconstrained guided context strings with optional bounded, case-local `pointers`; every reference and the existing case scope carry independently checked SHA256 values. No new authority, task state or permission grant.
- Guided writes, including `kind=context`, require explicit existing case and exact target identity. Unknown-target recovery exposes source pointers only; stale references withhold old titles and summaries. Guided updates cannot silently omit previous references.
- Default recovery quarantines all candidate claim titles and bodies, including v1.1 automatic narration. Explicit search remains available; conditional tool failures remain separate and cannot acquire a guessed target.
- `/continuity candidates on|off` disables only automatic narration. Commands validate usage without mutation; the option follows Pi native active-branch entries through reload, resume and tree navigation. New sessions default to on.
- Failure-condition values are limited to 160 characters in automatic recovery, with explicit omission/full-record/source pointers; stored records and explicit searches retain their full values. Guided source pointers precede automatic failures.
- Existing scoped records can be cancelled/retired after their case disappears, using exact original identity and stored pointer hashes plus a fresh source; active writes still require an existing case.
- v1.1 journals, cancelled tombstones, corruption handling, CAS revisions and branch filtering remain supported. Added partial 1/7 coverage, regression reopening, stale Evidence/scope, identity/path, candidate quarantine, display-budget and actual SDK/CLI/RPC acceptance tests.

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

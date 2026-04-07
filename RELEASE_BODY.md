# oh-my-codex v0.12.0

**Minor release for native Codex hook ownership, first-party Bash pre/post guidance, runtime/team delivery hardening, and workflow-doc refresh**

`0.12.0` follows `0.11.13` with a broad release train from `v0.11.13..release/0.12.0`: it promotes native Codex hook ownership into the repo/runtime contract, ships first-party Bash `PreToolUse` / `PostToolUse` guidance, hardens team/runtime delivery and operator steering, and refreshes docs/prompt guidance for the modern OMX workflow.

## Highlights

- Native Codex hook ownership now lives in the repo/runtime contract for non-team OMX sessions.
- First-party Bash `PreToolUse` / `PostToolUse` guidance is now supported and documented.
- Team runtime delivery, mailbox handling, pane-status visibility, and next-action steering are more robust.
- Windows/tmux launch reliability and worker supervision are improved.
- Prompt/AGENTS guidance now emphasizes quality-first, verification-heavy execution.
- Release metadata and collateral are aligned to `0.12.0`.

## What’s Changed

### Fixes
- harden repo-local native hook ownership, session-start continuity, and stop-state persistence
- strengthen team/runtime delivery, mailbox, persist-error, and next-action steering behavior
- preserve Windows/tmux launch reliability, shift-enter handling, and launcher command resolution
- keep notification/reminder/session continuity paths more reliable during live operator workflows

### Changed
- add first-party Bash `PreToolUse` / `PostToolUse` guidance for the native hook lane
- refresh prompt/AGENTS defaults toward quality-first, evidence-backed execution
- reorganize translated README/docs collateral under `docs/readme/` and extend Ukrainian docs coverage
- bump release metadata from `0.11.13` to `0.12.0` across Node/Cargo workspace manifests, lockfiles, and release collateral

## Verification

- `npm ci`
- `node dist/cli/omx.js version`
- `node --test dist/cli/__tests__/version-sync-contract.test.js`
- `cargo test -p omx-runtime-core`
- `npm run build`
- `npm run lint`
- `npm test`
- `npm run smoke:packed-install`
- `git diff --check origin/main...HEAD`

## Remaining risk

- This release verification is still a local release gate, not a full GitHub Actions matrix rerun.
- The release train is intentionally broad, so post-release monitoring should keep an eye on native hook setup/uninstall behavior, stop-state continuity, and team delivery/runtime behavior.

## Contributors

- [@Yeachan-Heo](https://github.com/Yeachan-Heo) (Bellman)

**Full Changelog**: [`v0.11.13...v0.12.0`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.11.13...v0.12.0)

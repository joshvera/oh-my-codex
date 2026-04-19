# oh-my-codex v0.14.0

## Summary

`0.14.0` is a minor release after `v0.13.2` focused on interactive orchestration. It introduces the new `omx question` blocking-question entrypoint, routes deep-interview rounds through structured question state, hard-deprecates direct `omx autoresearch` in favor of the skill-first validator-gated flow, adds advisory triage routing, and normalizes runtime run outcomes so Stop/continuation behavior stays consistent across execution surfaces.

## Added

- **`omx question` structured interactive entrypoint** — OMX now has a first-party blocking-question command for agent-invoked user questions, with JSON input, tmux/native renderer selection, persistent question records, and structured answer output.
- **Question-obligation tracking for deep-interview** — deep-interview can now mark a question as pending/required, satisfy it, and clear it explicitly so interactive progress is durable instead of inferred from free-form prompt text.
- **Advisory triage classifier** — non-keyword prompts now get PASS/LIGHT/HEAVY advisory routing backed by persisted triage state and follow-up suppression.

## Changed

- **Deep-interview now depends on `omx question`** — each interview round uses the OMX-owned question surface rather than plain-text fallback, making interactive clarification lifecycle and Stop semantics explicit.
- **Autoresearch is now validator-gated and skill-first** — the direct CLI entrypoint is hard-deprecated, users are steered to `$deep-interview --autoresearch` / `$autoresearch`, and completion now requires validator evidence.
- **Runtime stop/continue semantics are shared** — run outcomes are normalized into one contract so persistent loops and state writers agree on terminal versus non-terminal execution states.
- **Specialist routing boundaries are clearer** — `explore`, `researcher`, and `dependency-expert` paths now have narrower role ownership in both prompts and role routing.
- **Lint release gating is reproducible in dev workspaces** — `npm run lint` now targets tracked source roots (`src`, `bin`) so nested local runtime/worktree directories with their own Biome roots no longer poison release validation.

## Fixed

- **Interactive Stop gating** — pending deep-interview questions and incomplete autoresearch validation now block Stop consistently until the required interactive/validator work is complete.
- **Question renderer integration** — tmux strategy selection, answer injection, and question lifecycle transitions are exercised through the owned question runtime path.
- **Release metadata drift** — Node/Cargo package metadata, lockfiles, changelog, release body, release notes, and release-readiness docs are synchronized to `0.14.0`.

## Verification

- `npm run build`
- `npm run lint`
- `npx tsc --noEmit --pretty false --project tsconfig.json`
- `node --test dist/cli/__tests__/question.test.js dist/question/__tests__/deep-interview.test.js dist/question/__tests__/renderer.test.js dist/question/__tests__/ui.test.js dist/cli/__tests__/autoresearch-guided.test.js dist/autoresearch/__tests__/skill-validation.test.js dist/hooks/__tests__/keyword-detector.test.js dist/hooks/__tests__/triage-heuristic.test.js dist/hooks/__tests__/triage-state.test.js dist/runtime/__tests__/run-outcome.test.js dist/runtime/__tests__/run-loop.test.js dist/scripts/__tests__/codex-native-hook.test.js dist/team/__tests__/role-router.test.js dist/cli/__tests__/question-helpers.test.js dist/question/__tests__/policy.test.js`
- `node --test dist/catalog/__tests__/schema.test.js dist/catalog/__tests__/generator.test.js dist/cli/__tests__/autoresearch.test.js dist/hooks/__tests__/analyze-routing-contract.test.js dist/hooks/__tests__/analyze-skill-contract.test.js dist/hooks/__tests__/notify-fallback-watcher.test.js dist/hooks/__tests__/notify-hook-auto-nudge.test.js dist/hooks/__tests__/notify-hook-cross-worktree.test.js dist/hooks/__tests__/notify-hook-managed-tmux.test.js dist/hooks/__tests__/notify-hook-ralph-resume.test.js dist/hooks/__tests__/notify-hook-tmux-heal.test.js dist/prompts/__tests__/guidance-contract.test.js dist/prompts/__tests__/orchestration-boundary-contract.test.js dist/prompts/__tests__/team-routing-contract.test.js`
- `node --test dist/cli/__tests__/version-sync-contract.test.js`
- `node dist/scripts/generate-catalog-docs.js --check`
- `npm run smoke:packed-install`
- `npm pack --dry-run`

## Remaining risk

- This is a local release-readiness pass, not a full GitHub Actions matrix rerun.
- `omx question` and advisory triage touch interactive/operator-facing surfaces that are best further observed in real tmux and multi-session environments after release.
- The release changes prompt routing, runtime stop semantics, and validator gating together, so post-release monitoring should focus on deep-interview/autoresearch flows and long-running OMX sessions.

## Contributors

Thanks to Yeachan-Heo, Bellman, HaD0Yun, HaDoYun, Oxidane-bot, and LEON for contributing to this release.

**Full Changelog**: [`v0.13.2...v0.14.0`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.13.2...v0.14.0)

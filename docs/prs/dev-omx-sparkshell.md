# PR Draft: Add `omx sparkshell` Rust sidecar preview

## Target branch
`dev`

## Summary
This PR adds a preview implementation of `omx sparkshell <command> [args...]`.

The feature wires a new OMX CLI subcommand to a Rust sidecar that runs commands directly, keeps short output raw, and uses local Codex CLI summarization for long output. It also introduces an embedded command-family registry, packaging/build helpers, and initial tests/docs for the new flow.

## Changes
- add `omx sparkshell` CLI dispatch and help text in the JS/TS CLI
- add `src/cli/sparkshell.ts` for native binary discovery + sidecar launch
- add a Rust crate at `native/omx-sparkshell/` for:
  - direct argv command execution
  - opt-in tmux pane capture mode for larger team/worker scrollback summaries
  - line-threshold branching
  - Codex summary bridge via `codex exec`
  - prompt assembly + summary shaping
  - command-family registry modules
- package the native binary under `bin/native/linux-x64/omx-sparkshell`
- add helper scripts:
  - `scripts/build-sparkshell.mjs`
  - `scripts/test-sparkshell.mjs`
- add preview docs in `README.md`
- add focused tests:
  - `src/cli/__tests__/sparkshell-cli.test.ts`
  - `src/cli/__tests__/sparkshell-packaging.test.ts`
  - native tests under `native/omx-sparkshell/tests/`

## Why this is good
- creates a bounded Rust entry point without forcing a full CLI rewrite
- gives OMX a fast shell-output summarization surface
- lets team leaders opt in to summarizing larger tmux pane tails without baking always-on JS status logic into the workflow
- keeps existing `--spark` / `--madmax-spark` worker semantics separate from sparkshell env-driven model routing
- establishes a reusable native foundation for future Rust CLI work

## User-visible behavior
- `omx sparkshell <command> [args...]`
- `omx sparkshell --tmux-pane <pane-id> --tail-lines <100-1000>` for explicit tmux pane capture summarization
- raw output when output lines are at or below `OMX_SPARKSHELL_LINES`
- markdown summary when output is longer, limited to:
  - `summary:`
  - `failures:`
  - `warnings:`
- tmux pane summarization remains opt-in; it is not always-on in `omx team status`
- summary model precedence:
  - `OMX_SPARKSHELL_MODEL`
  - `OMX_SPARK_MODEL`
  - spark default model
- native binary lookup precedence:
  - `OMX_SPARKSHELL_BIN`
  - packaged `bin/native/<platform>-<arch>/omx-sparkshell[.exe]`
  - repo-local `native/omx-sparkshell/target/release/omx-sparkshell[.exe]`

## Validation
From teammate execution evidence plus follow-up Ralph verification:
- [x] `cargo check` PASS
- [x] `cargo test` PASS (`15 unit`, `5 integration`, `5 registry`)
- [x] `cargo fmt --check` PASS
- [x] `omx-sparkshell --tmux-pane <pane> --tail-lines 400` path covered by native tests with fake `tmux` + `codex`
- [x] `node scripts/build-sparkshell.mjs` PASS
- [x] `node scripts/test-sparkshell.mjs` PASS
- [x] `node --test dist/cli/__tests__/sparkshell-packaging.test.js` PASS
- [x] `npm pack --dry-run --json` PASS
- [x] clean LSP diagnostics for `src/cli/__tests__/sparkshell-packaging.test.ts`

## Notes / Risks
- preview implementation currently packages a Linux x64 native artifact in-tree
- the wider workspace still had earlier reports of pre-existing dependency/build friction during team execution, so final CI should confirm end-to-end root build/test on a clean environment
- worker-4 died mid-run; task 4 was successfully recovered and completed by worker-1 before team shutdown

## Related artifacts
- PRD: `.omx/plans/prd-omx-sparkshell.md`
- Test spec: `.omx/plans/test-spec-omx-sparkshell.md`
- Deep interview spec: `.omx/specs/deep-interview-omx-sparkshell.md`

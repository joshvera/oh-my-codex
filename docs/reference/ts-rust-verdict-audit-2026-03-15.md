# TS ↔ Rust verdict-parity audit — 2026-03-15

Overall verdict: PARTIAL.

TypeScript remains the behavioral SSOT. Rust owns several execution boundaries and a few strong bounded slices, but full behavioral parity is not yet proven.

## Lane 1 — startup contract / runtime parity
- Verdict: PARTIAL
- TS SSOT evidence: `src/team/runtime.ts:725`, `src/team/runtime.ts:1238`, `src/team/runtime.ts:1599`, `src/team/runtime.ts:2172`, `src/team/runtime.ts:2621`
- Rust evidence: `crates/omx-runtime/src/runtime_run.rs:84`, `crates/omx-runtime/src/runtime_run.rs:152`, `crates/omx-runtime/src/runtime_run.rs:793`, `src/mcp/team-server.ts:356`
- Strongest Rust-owned slice: MCP now spawns native `runtime-run`, and Rust owns startup/monitor/shutdown loop scaffolding.
- Highest-confidence remaining gap: TS still owns richer lifecycle semantics such as direct mailbox/inbox dispatch flows, rebalance policy, and structured verification gating.
- Doc truthfulness: truthful

## Lane 2 — tmux control-plane parity
- Verdict: FAIL for full parity, PASS for primitive helper seam
- TS SSOT evidence: `src/team/tmux-session.ts:760`, `src/team/tmux-session.ts:975`, `src/team/tmux-session.ts:1182`, `src/team/tmux-session.ts:1290`, `src/team/tmux-session.ts:1525`, `src/team/tmux-session.ts:1565`
- Rust evidence: `crates/omx-runtime/src/tmux.rs:17`, `crates/omx-runtime/src/tmux.rs:50`, `crates/omx-runtime/src/tmux.rs:86`
- Strongest Rust-owned slice: send-key and capture-pane primitives.
- Highest-confidence remaining gap: team session topology, readiness polling, trust-prompt dismissal, and teardown orchestration remain TS-owned.
- Doc truthfulness: truthful

## Lane 3 — HUD behavior parity
- Verdict: PARTIAL
- TS SSOT evidence: `src/hud/index.ts:74`, `src/hud/state.ts:226`, `src/hud/render.ts:190`
- Rust evidence: `crates/omx-runtime/src/hud.rs:7`, `crates/omx-runtime/src/hud.rs:51`, `src/cli/runtime-native.ts:43`
- Strongest Rust-owned slice: guarded native `hud-watch` launch boundary.
- Highest-confidence remaining gap: Rust does not implement TS-equivalent state loading or rendering behavior; current renderer is a minimal placeholder.
- Doc truthfulness: truthful

## Lane 4 — watchers / reply-listener parity
- Verdict: PARTIAL
- TS SSOT evidence: `scripts/notify-fallback-watcher.js:45`, `scripts/notify-fallback-watcher.js:145`, `scripts/hook-derived-watcher.js:45`, `src/notifications/reply-listener.ts:130`, `src/notifications/reply-listener.ts:209`, `src/notifications/reply-listener.ts:446`
- Rust evidence: `crates/omx-runtime/src/watchers.rs:16`, `crates/omx-runtime/src/watchers.rs:27`, `crates/omx-runtime/src/reply_listener.rs:46`, `crates/omx-runtime/src/reply_listener.rs:145`, `crates/omx-runtime/src/reply_listener.rs:365`
- Strongest Rust-owned slice: reply-listener config parsing, Discord fetch command, cursor progression, registry lookup, injection/log/state updates.
- Highest-confidence remaining gap: watcher loops are still minimal pid-file/sleep shims, while JS watchers still own richer control-plane behavior.
- Doc truthfulness: truthful

## Lane 5 — MCP / CLI boundary mapping and truthfulness
- Verdict: PARTIAL
- TS SSOT evidence: `src/mcp/team-server.ts:340`, `src/mcp/team-server.ts:356`, `src/cli/runtime-native.ts:39`, `src/cli/runtime-native.ts:43`, `src/cli/runtime-native.ts:87`
- Rust evidence: `crates/omx-runtime/src/main.rs:30`, `crates/omx-runtime/src/main.rs:39`, `crates/omx-runtime/src/topology.rs:1`
- Strongest Rust-owned slice: native command surface and binary resolution/spawn boundary are explicit and test-backed.
- Highest-confidence remaining gap: boundary migration is ahead of behavioral migration, so topology/ownership statements must not be read as full parity claims.
- Doc truthfulness: truthful after the bounded-ownership refresh in `docs/reference/ts-rust-parity-lanes.md` and `crates/omx-runtime/src/topology.rs`.

## Verification
- `npm run build -- --pretty false` — PASS
- `node --test dist/verification/__tests__/phase1-runtime-surface-parity.test.js` — PASS (5/5)
- `node --test dist/verification/__tests__/ts-rust-parity-lanes-doc.test.js` — PASS (1/1)
- `cargo test -p omx-runtime` — PASS (71/71)

## Bottom line
The current docs are materially truthful and conservative. The strongest proven native slices are the runtime launch boundary and reply-listener internals. The highest-confidence blockers to any broader parity claim remain runtime lifecycle parity, tmux orchestration parity, and the still-minimal watcher/HUD behavior in Rust.

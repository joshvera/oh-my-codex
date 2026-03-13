import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPhase1HudWatchCommand, buildRuntimeCapturePaneCommand } from '../runtime-native.js';

describe('runtime-native command builders', () => {
  it('builds native capture-pane commands for team status integration', () => {
    assert.equal(
      buildRuntimeCapturePaneCommand('%21', 400),
      'omx-runtime capture-pane --pane-id %21 --tail-lines 400',
    );
  });

  it('defaults hud watch command to the legacy node entrypoint until native hud is enabled', () => {
    assert.equal(
      buildPhase1HudWatchCommand('/tmp/bin/omx.js'),
      "node '/tmp/bin/omx.js' hud --watch",
    );
  });

  it('can emit a native hud command when the explicit rollout flag is enabled', () => {
    assert.equal(
      buildPhase1HudWatchCommand('/tmp/bin/omx.js', {
        env: { OMX_RUNTIME_HUD_NATIVE: '1' },
      }),
      "'omx-runtime' hud-watch",
    );
  });

  it('preserves allowed hud presets across both lanes', () => {
    assert.equal(
      buildPhase1HudWatchCommand('/tmp/bin/omx.js', { preset: 'minimal' }),
      "node '/tmp/bin/omx.js' hud --watch --preset=minimal",
    );
    assert.equal(
      buildPhase1HudWatchCommand('/tmp/bin/omx.js', {
        preset: 'focused',
        env: { OMX_RUNTIME_HUD_NATIVE: '1', OMX_RUNTIME_BIN: '/tmp/rust/omx-runtime' },
      }),
      "'/tmp/rust/omx-runtime' hud-watch --preset=focused",
    );
  });
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

describe('notify-hook native dispatch contract', () => {
  it('force-enables hook dispatch for notify-hook native and derived events via dispatcher policy', async () => {
    const notifyHookSource = await readFile(join(process.cwd(), 'src', 'scripts', 'notify-hook.ts'), 'utf-8');
    const dispatcherSource = await readFile(join(process.cwd(), 'src', 'hooks', 'extensibility', 'dispatcher.ts'), 'utf-8');

    assert.match(notifyHookSource, /dispatchHookEvent\(event, \{ cwd \}\);/);
    assert.match(notifyHookSource, /dispatchHookEvent\(derivedEvent, \{ cwd \}\);/);
    const notifyEventMatches = notifyHookSource.match(/dispatchHookEvent\(event, \{ cwd \}\);/g) ?? [];
    assert.ok(notifyEventMatches.length >= 2, `expected notify-hook to dispatch native events twice, found ${notifyEventMatches.length}`);

    assert.match(dispatcherSource, /event\.source === "native" \|\| event\.source === "derived"/);
    assert.match(dispatcherSource, /const enabled = options\.enabled \?\? runtimeHookDispatchEnabled;/);
  });
});

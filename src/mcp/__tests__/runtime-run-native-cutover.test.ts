import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('runtime-run native cutover guard', () => {
  it('keeps the runtime-run bootstrap/start seam fully native', () => {
    const runtimeRunSource = readFileSync(
      join(process.cwd(), 'crates', 'omx-runtime', 'src', 'runtime_run.rs'),
      'utf8',
    );

    assert.match(runtimeRunSource, /fn start_team\(/);
    assert.doesNotMatch(
      runtimeRunSource,
      /const START_TEAM_SCRIPT:/,
      'runtime_run.rs should not embed a Node startTeam helper after the native cutover',
    );
    assert.doesNotMatch(
      runtimeRunSource,
      /import \{ startTeam \} from '\.\/dist\/team\/runtime\.js'/,
      'runtime_run.rs should not import dist\/team\/runtime.js after the native cutover',
    );
    assert.doesNotMatch(
      runtimeRunSource,
      /OMX_RUNTIME_NODE_PROGRAM/,
      'runtime_run.rs should not resolve a Node runtime program for runtime-run after the native cutover',
    );
    assert.doesNotMatch(
      runtimeRunSource,
      /execute_node_json\(/,
      'runtime_run.rs should not route runtime-run start/bootstrap through execute_node_json after the native cutover',
    );
    assert.doesNotMatch(
      runtimeRunSource,
      /--input-type=module/,
      'runtime_run.rs should not launch inline Node module helpers after the native cutover',
    );
  });
});

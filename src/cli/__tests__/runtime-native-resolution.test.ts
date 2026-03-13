import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  packagedRuntimeBinaryPath,
  repoLocalRuntimeBinaryPath,
  nestedRepoLocalRuntimeBinaryPath,
  resolveRuntimeBinaryPath,
} from '../runtime-native.js';

describe('runtime-native binary resolution', () => {
  it('resolves a relative OMX_RUNTIME_BIN override against cwd', () => {
    const resolved = resolveRuntimeBinaryPath({
      cwd: '/repo/worktree',
      env: { OMX_RUNTIME_BIN: './bin/custom/omx-runtime' },
      exists: () => false,
    });

    assert.equal(resolved, '/repo/worktree/bin/custom/omx-runtime');
  });

  it('prefers the packaged runtime binary before repo-local fallbacks', () => {
    const packageRoot = '/repo';
    const packaged = packagedRuntimeBinaryPath(packageRoot, 'linux', 'x64');
    const repoLocal = repoLocalRuntimeBinaryPath(packageRoot, 'linux');
    const nested = nestedRepoLocalRuntimeBinaryPath(packageRoot, 'linux');

    const resolved = resolveRuntimeBinaryPath({
      cwd: packageRoot,
      packageRoot,
      platform: 'linux',
      arch: 'x64',
      exists: (path) => path === packaged || path === repoLocal || path === nested,
    });

    assert.equal(resolved, packaged);
  });

  it('falls back to target/release when the packaged runtime binary is absent', () => {
    const packageRoot = '/repo';
    const repoLocal = repoLocalRuntimeBinaryPath(packageRoot, 'linux');

    const resolved = resolveRuntimeBinaryPath({
      cwd: packageRoot,
      packageRoot,
      platform: 'linux',
      arch: 'x64',
      exists: (path) => path === repoLocal,
    });

    assert.equal(resolved, repoLocal);
  });

  it('falls back to crates/omx-runtime/target/release as the last repo-local candidate', () => {
    const packageRoot = '/repo';
    const nested = nestedRepoLocalRuntimeBinaryPath(packageRoot, 'linux');

    const resolved = resolveRuntimeBinaryPath({
      cwd: packageRoot,
      packageRoot,
      platform: 'linux',
      arch: 'x64',
      exists: (path) => path === nested,
    });

    assert.equal(resolved, nested);
  });
});

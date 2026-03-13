import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const nativeRoot = join(projectRoot, 'crates', 'omx-runtime');
const manifestPath = process.env.OMX_RUNTIME_MANIFEST ?? join(nativeRoot, 'Cargo.toml');
const binaryName = platform() === 'win32' ? 'omx-runtime.exe' : 'omx-runtime';
const releaseBinaryPath = join(projectRoot, 'target', 'release', binaryName);
const packagedBinaryDir = join(projectRoot, 'bin', 'rust', `${platform()}-${arch()}`);
const packagedBinaryPath = join(packagedBinaryDir, binaryName);
const extraArgs = process.argv.slice(2);
const args = ['build', '--manifest-path', manifestPath, '--release', ...extraArgs];

if (!existsSync(manifestPath)) {
  console.error(`omx runtime build: missing Rust manifest at ${manifestPath}`);
  process.exit(1);
}

const result = spawnSync('cargo', args, {
  cwd: projectRoot,
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  console.error(`omx runtime build: failed to launch cargo: ${result.error.message}`);
  process.exit(1);
}

if ((result.status ?? 1) !== 0) {
  process.exit(result.status ?? 1);
}

if (!existsSync(releaseBinaryPath)) {
  console.error(`omx runtime build: expected release binary at ${releaseBinaryPath}`);
  process.exit(1);
}

mkdirSync(packagedBinaryDir, { recursive: true });
copyFileSync(releaseBinaryPath, packagedBinaryPath);
if (platform() !== 'win32') {
  chmodSync(packagedBinaryPath, 0o755);
}
console.log(`omx runtime build: staged native binary at ${packagedBinaryPath}`);

import { existsSync } from 'fs';
import { arch as osArch } from 'os';
import { isAbsolute, join, resolve } from 'path';
import { getPackageRoot } from '../utils/package.js';
import {
  RUNTIME_BIN_ENV as RUNTIME_BIN_ENV_SHARED,
  getPackageVersion,
  hydrateNativeBinary,
  resolveCachedNativeBinaryPath,
} from './native-assets.js';

export const RUNTIME_BIN_ENV = RUNTIME_BIN_ENV_SHARED;
const RUNTIME_HUD_NATIVE_ENV = 'OMX_RUNTIME_HUD_NATIVE';

export interface ResolveRuntimeBinaryPathOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  packageRoot?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  exists?: (path: string) => boolean;
}

export interface BuildPhase1HudWatchCommandOptions {
  env?: NodeJS.ProcessEnv;
  preset?: string;
  runtimeBinary?: string;
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function parseHudPreset(value: string | undefined): string | undefined {
  if (value === 'minimal' || value === 'focused' || value === 'full') return value;
  return undefined;
}

export function buildRuntimeCapturePaneCommand(paneId: string, tailLines: number): string {
  return `omx-runtime capture-pane --pane-id ${paneId} --tail-lines ${tailLines}`;
}

export function buildPhase1HudWatchCommand(
  omxBin: string,
  options: BuildPhase1HudWatchCommandOptions = {},
): string {
  const env = options.env ?? process.env;
  const preset = parseHudPreset(options.preset);
  const presetArg = preset ? ` --preset=${preset}` : '';

  if (env[RUNTIME_HUD_NATIVE_ENV] === '1') {
    const runtimeBinary = options.runtimeBinary?.trim()
      || env[RUNTIME_BIN_ENV]?.trim()
      || runtimeBinaryName(process.platform);
    return `${quoteShellArg(runtimeBinary)} hud-watch${presetArg}`;
  }

  return `node ${quoteShellArg(omxBin)} hud --watch${presetArg}`;
}

export function runtimeBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'omx-runtime.exe' : 'omx-runtime';
}

export function packagedRuntimeBinaryPath(
  packageRoot = getPackageRoot(),
  platform: NodeJS.Platform = process.platform,
  arch: string = osArch(),
): string {
  return join(packageRoot, 'bin', 'rust', `${platform}-${arch}`, runtimeBinaryName(platform));
}

export function repoLocalRuntimeBinaryPath(
  packageRoot = getPackageRoot(),
  platform: NodeJS.Platform = process.platform,
): string {
  return join(packageRoot, 'target', 'release', runtimeBinaryName(platform));
}

export function nestedRepoLocalRuntimeBinaryPath(
  packageRoot = getPackageRoot(),
  platform: NodeJS.Platform = process.platform,
): string {
  return join(packageRoot, 'crates', 'omx-runtime', 'target', 'release', runtimeBinaryName(platform));
}

export function resolveRuntimeBinaryPath(options: ResolveRuntimeBinaryPathOptions = {}): string {
  const {
    cwd = process.cwd(),
    env = process.env,
    packageRoot = getPackageRoot(),
    platform = process.platform,
    arch = osArch(),
    exists = existsSync,
  } = options;

  const override = env[RUNTIME_BIN_ENV]?.trim();
  if (override) {
    return isAbsolute(override) ? override : resolve(cwd, override);
  }

  const packaged = packagedRuntimeBinaryPath(packageRoot, platform, arch);
  if (exists(packaged)) return packaged;

  const repoLocal = repoLocalRuntimeBinaryPath(packageRoot, platform);
  if (exists(repoLocal)) return repoLocal;

  const nestedRepoLocal = nestedRepoLocalRuntimeBinaryPath(packageRoot, platform);
  if (exists(nestedRepoLocal)) return nestedRepoLocal;

  throw new Error(
    `[runtime-native] native binary not found. Checked ${packaged}, ${repoLocal}, and ${nestedRepoLocal}. `
      + `Set ${RUNTIME_BIN_ENV} to override the path.`
  );
}

export async function resolveRuntimeBinaryPathWithHydration(
  options: ResolveRuntimeBinaryPathOptions = {},
): Promise<string> {
  const {
    cwd = process.cwd(),
    env = process.env,
    packageRoot = getPackageRoot(),
    platform = process.platform,
    arch = osArch(),
    exists = existsSync,
  } = options;

  const override = env[RUNTIME_BIN_ENV]?.trim();
  if (override) {
    return isAbsolute(override) ? override : resolve(cwd, override);
  }

  const version = await getPackageVersion(packageRoot);
  const cached = resolveCachedNativeBinaryPath('omx-runtime', version, platform, arch, env);
  if (exists(cached)) return cached;

  const packaged = packagedRuntimeBinaryPath(packageRoot, platform, arch);
  if (exists(packaged)) return packaged;

  const repoLocal = repoLocalRuntimeBinaryPath(packageRoot, platform);
  if (exists(repoLocal)) return repoLocal;

  const nestedRepoLocal = nestedRepoLocalRuntimeBinaryPath(packageRoot, platform);
  if (exists(nestedRepoLocal)) return nestedRepoLocal;

  const hydrated = await hydrateNativeBinary('omx-runtime', { packageRoot, env, platform, arch });
  if (hydrated) return hydrated;

  throw new Error(
    `[runtime-native] native binary not found. Checked ${cached}, ${packaged}, ${repoLocal}, and ${nestedRepoLocal}. `
      + `Reconnect to the network so OMX can fetch the release asset, or set ${RUNTIME_BIN_ENV} to override the path.`
  );
}

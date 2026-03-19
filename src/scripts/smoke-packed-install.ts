import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const REQUIRED_NODE_MODULE_MARKERS = [
  join('typescript', 'package.json'),
  join('@iarna', 'toml', 'package.json'),
  join('@modelcontextprotocol', 'sdk', 'package.json'),
  join('zod', 'package.json'),
];

function usage(): string {
  return [
    'Usage: node scripts/smoke-packed-install.mjs [--release-assets-dir <dir>] [--require-no-fallback]',
    '',
    'Creates an npm tarball, installs it into an isolated prefix, and smoke tests the installed omx CLI.',
    'When --release-assets-dir is provided, native hydration is also exercised using a local HTTP server.',
  ].join('\n');
}

function hasNodeModulesPath(nodeModulesPath: string): boolean {
  try {
    lstatSync(nodeModulesPath);
    return true;
  } catch {
    return false;
  }
}

export function hasUsableNodeModules(repoRoot: string): boolean {
  return REQUIRED_NODE_MODULE_MARKERS.every((marker) => existsSync(join(repoRoot, 'node_modules', marker)));
}

export function resolveGitCommonDir(cwd: string, gitRunner = spawnSync): string | null {
  const result = gitRunner('git', ['rev-parse', '--git-common-dir'], {
    cwd,
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    return null;
  }
  const value = (result.stdout || '').trim();
  if (!value) {
    return null;
  }
  return resolve(cwd, value);
}

interface EnsureRepoDepsOptions {
  gitRunner?: typeof spawnSync;
  install?: (cwd: string) => void;
  remove?: typeof rmSync;
  symlink?: typeof symlinkSync;
  log?: (message: string) => void;
  platformName?: string;
}

interface EnsureRepoDepsResult {
  strategy: string;
  nodeModulesPath: string;
  sourceNodeModulesPath?: string;
}

export function resolveReusableNodeModulesSource(repoRoot: string, gitRunner = spawnSync): string | null {
  const commonDir = resolveGitCommonDir(repoRoot, gitRunner);
  if (!commonDir || basename(commonDir) !== '.git') {
    return null;
  }

  const primaryRepoRoot = dirname(commonDir);
  if (resolve(primaryRepoRoot) === resolve(repoRoot)) {
    return null;
  }

  if (!hasUsableNodeModules(primaryRepoRoot)) {
    return null;
  }

  return join(primaryRepoRoot, 'node_modules');
}

function formatCommandFailure(cmd: string, args: string[], result: { stdout?: string; stderr?: string }): string {
  return [
    `Command failed: ${cmd} ${args.join(' ')}`,
    result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : '',
    result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : '',
  ].filter(Boolean).join('\n\n');
}

export function ensureRepoDependencies(repoRoot: string, options: EnsureRepoDepsOptions = {}): EnsureRepoDepsResult {
  const {
    gitRunner = spawnSync,
    install = (cwd: string) => {
      const result = spawnSync('npm', ['ci'], {
        cwd,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      if (result.status !== 0) {
        throw new Error(formatCommandFailure('npm', ['ci'], result));
      }
    },
    remove = rmSync,
    symlink = symlinkSync,
    log = () => {},
    platformName = process.platform,
  } = options;

  if (hasUsableNodeModules(repoRoot)) {
    return {
      strategy: 'existing',
      nodeModulesPath: join(repoRoot, 'node_modules'),
    };
  }

  const targetNodeModules = join(repoRoot, 'node_modules');
  if (hasNodeModulesPath(targetNodeModules)) {
    remove(targetNodeModules, { recursive: true, force: true });
  }

  const reusableNodeModules = resolveReusableNodeModulesSource(repoRoot, gitRunner);
  if (reusableNodeModules) {
    symlink(reusableNodeModules, targetNodeModules, platformName === 'win32' ? 'junction' : 'dir');
    log(`[smoke:packed-install] Reusing node_modules from ${reusableNodeModules}`);
    return {
      strategy: 'symlink',
      nodeModulesPath: targetNodeModules,
      sourceNodeModulesPath: reusableNodeModules,
    };
  }

  log('[smoke:packed-install] Installing repo dependencies with npm ci');
  install(repoRoot);
  return {
    strategy: 'installed',
    nodeModulesPath: targetNodeModules,
  };
}

export function hasSparkShellFallbackBanner(stderr: string | undefined): boolean {
  return /GLIBC-incompatible native sidecar detected/i.test(String(stderr || ''));
}

function parseArgs(argv: string[]): { releaseAssetsDir: string | undefined; requireNoFallback: boolean } {
  let releaseAssetsDir: string | undefined;
  let requireNoFallback = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (token === '--release-assets-dir') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value after --release-assets-dir');
      releaseAssetsDir = resolve(value);
      index += 1;
      continue;
    }
    if (token === '--require-no-fallback') {
      requireNoFallback = true;
      continue;
    }
    throw new Error(`Unknown argument: ${token}\n${usage()}`);
  }
  return { releaseAssetsDir, requireNoFallback };
}

function run(cmd: string, args: string[], options: Record<string, unknown> = {}): ReturnType<typeof spawnSync> {
  const result = spawnSync(cmd, args, {
    encoding: 'utf-8',
    stdio: 'pipe',
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(cmd, args, result));
  }
  return result;
}

function npmBinName(name: string): string {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function startStaticServer(root: string): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolveServer, reject) => {
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const requested = resolve(root, url.pathname.replace(/^\//, ''));
        if (!requested.startsWith(root) || !existsSync(requested)) {
          res.writeHead(404);
          res.end('missing');
          return;
        }
        res.writeHead(200);
        res.end(readFileSync(requested));
      } catch (error) {
        res.writeHead(500);
        res.end(String(error));
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo | null;
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to bind local asset server'));
        return;
      }
      resolveServer({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((done, fail) => server.close((error) => error ? fail(error) : done())),
      });
    });
  });
}

function writeCodexStub(binDir: string): string {
  const stubPath = join(binDir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  if (process.platform === 'win32') {
    writeFileSync(stubPath, [
      '@echo off',
      'setlocal enabledelayedexpansion',
      'set output_path=',
      ':loop',
      'if "%~1"=="" goto done',
      'if "%~1"=="-o" (',
      '  set output_path=%~2',
      '  shift',
      ')',
      'shift',
      'goto loop',
      ':done',
      'if "%output_path%"=="" exit /b 1',
      '> "%output_path%" echo # Answer',
      '>> "%output_path%" echo - packed install smoke harness',
      'exit /b 0',
      '',
    ].join('\r\n'));
  } else {
    writeFileSync(stubPath, [
      '#!/bin/sh',
      'set -eu',
      "output_path=''",
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "-o" ] && [ "$#" -ge 2 ]; then',
      '    output_path="$2"',
      '    shift 2',
      '    continue',
      '  fi',
      '  shift',
      'done',
      'if [ -z "$output_path" ]; then',
      "  printf 'missing -o output path\\n' >&2",
      '  exit 1',
      'fi',
      "printf '# Answer\\n- packed install smoke harness\\n' > \"$output_path\"",
      '',
    ].join('\n'));
    chmodSync(stubPath, 0o755);
  }
  return stubPath;
}

export function prepareLocalHydrationAssetDirectory(sourceDir: string, tempRoot: string): string {
  const localDir = join(tempRoot, 'hydration-assets');
  cpSync(sourceDir, localDir, { recursive: true });
  return localDir;
}

export function rewriteManifestDownloadUrls(manifestPath: string, baseUrl: string): void {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { assets: Array<{ archive: string; download_url: string }> };
  manifest.assets = Array.isArray(manifest.assets)
    ? manifest.assets.map((asset) => ({
      ...asset,
      download_url: new URL(asset.archive, `${baseUrl}/`).toString(),
    }))
    : [];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function main(): Promise<void> {
  const { releaseAssetsDir, requireNoFallback } = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const tempRoot = mkdtempSync(join(tmpdir(), 'omx-packed-install-'));
  const prefixDir = join(tempRoot, 'prefix');
  const cacheDir = join(tempRoot, 'cache');
  const helperBinDir = join(tempRoot, 'bin');
  mkdirSync(prefixDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(helperBinDir, { recursive: true });

  let server: { baseUrl: string; close: () => Promise<void> } | undefined;
  let tarballPath: string | undefined;
  try {
    ensureRepoDependencies(repoRoot, {
      log: (message: string) => console.log(message),
    });

    const pack = run('npm', ['pack', '--json'], { cwd: repoRoot });
    const packOutput = JSON.parse((pack.stdout as string).slice((pack.stdout as string).indexOf('['))) as Array<{ filename: string }>;
    const tarballName = packOutput[0]?.filename;
    if (!tarballName) throw new Error('npm pack did not return a tarball filename');
    tarballPath = join(repoRoot, tarballName);

    run('npm', ['install', '-g', tarballPath, '--prefix', prefixDir], { cwd: repoRoot });

    const omxPath = join(prefixDir, process.platform === 'win32' ? '' : 'bin', npmBinName('omx'));
    run(omxPath, ['version'], { cwd: repoRoot });
    run(omxPath, ['--help'], { cwd: repoRoot });

    if (releaseAssetsDir) {
      const hydrationAssetsDir = prepareLocalHydrationAssetDirectory(releaseAssetsDir, tempRoot);
      server = await startStaticServer(hydrationAssetsDir);
      rewriteManifestDownloadUrls(join(hydrationAssetsDir, 'native-release-manifest.json'), server.baseUrl);
      const codexStub = writeCodexStub(helperBinDir);
      const env = {
        ...process.env,
        PATH: `${helperBinDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH || ''}`,
        OMX_NATIVE_MANIFEST_URL: `${server.baseUrl}/native-release-manifest.json`,
        OMX_NATIVE_CACHE_DIR: cacheDir,
        OMX_EXPLORE_CODEX_BIN: codexStub,
      };

      const sparkshell = run(omxPath, ['sparkshell', 'node', '--version'], { cwd: repoRoot, env });
      if (requireNoFallback && hasSparkShellFallbackBanner(sparkshell.stderr as string)) {
        throw new Error(`Unexpected sparkshell fallback stderr:\n${sparkshell.stderr}`);
      }
      if (!/v\d+\./.test(sparkshell.stdout as string)) {
        throw new Error(`Unexpected sparkshell stdout:\n${sparkshell.stdout}`);
      }

      const explore = run(omxPath, ['explore', '--prompt', 'where is buildExploreRoutingGuidance defined'], { cwd: repoRoot, env });
      if (!(explore.stdout as string).includes('# Answer') || !(explore.stdout as string).includes('packed install smoke harness')) {
        throw new Error(`Unexpected explore stdout:\n${explore.stdout}`);
      }
    }

    console.log('packed install smoke: PASS');
  } finally {
    if (tarballPath) rmSync(tarballPath, { force: true });
    if (server) await server.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`packed install smoke: FAIL\n${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

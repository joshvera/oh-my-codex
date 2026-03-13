#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import TOML from '@iarna/toml';

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
const workspace = TOML.parse(readFileSync(join(root, 'Cargo.toml'), 'utf-8'));
const explore = TOML.parse(readFileSync(join(root, 'crates', 'omx-explore', 'Cargo.toml'), 'utf-8'));
const runtime = TOML.parse(readFileSync(join(root, 'crates', 'omx-runtime', 'Cargo.toml'), 'utf-8'));
const sparkshell = TOML.parse(readFileSync(join(root, 'crates', 'omx-sparkshell', 'Cargo.toml'), 'utf-8'));
const tagArgIndex = process.argv.indexOf('--tag');
const tag = tagArgIndex >= 0 ? process.argv[tagArgIndex + 1] : undefined;

const pkgVersion = String(pkg.version || '').trim();
const workspaceVersion = String(workspace.workspace?.package?.version || '').trim();
const problems = [];

if (!pkgVersion) problems.push('package.json version is missing');
if (!workspaceVersion) problems.push('Cargo.toml [workspace.package].version is missing');
if (pkgVersion && workspaceVersion && pkgVersion !== workspaceVersion) {
  problems.push(`package.json version (${pkgVersion}) does not match workspace version (${workspaceVersion})`);
}
if (explore.package?.version?.workspace !== true) {
  problems.push('crates/omx-explore/Cargo.toml must use version.workspace = true');
}
if (runtime.package?.version?.workspace !== true) {
  problems.push('crates/omx-runtime/Cargo.toml must use version.workspace = true');
}
if (sparkshell.package?.version?.workspace !== true) {
  problems.push('crates/omx-sparkshell/Cargo.toml must use version.workspace = true');
}
if (tag && tag !== `v${pkgVersion}`) {
  problems.push(`release tag (${tag}) does not match package.json version (v${pkgVersion})`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`[version-sync] ${problem}`);
  process.exit(1);
}

console.log(`[version-sync] OK package=${pkgVersion} workspace=${workspaceVersion}${tag ? ` tag=${tag}` : ''}`);

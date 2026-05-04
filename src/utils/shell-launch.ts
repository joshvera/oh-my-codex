import { existsSync } from 'fs';

export type ShellFamily = 'sh' | 'bash' | 'zsh' | 'dash' | 'fish';

export interface ShellLaunchSpec {
  family: ShellFamily;
  shell: string;
  rcFile: string | null;
}

type ExistsSyncLike = (path: string) => boolean;

interface ShellFamilySpec {
  family: ShellFamily;
  paths: string[];
  rcFile: string | null;
}

const SHELL_FAMILY_SPECS: ShellFamilySpec[] = [
  {
    family: 'sh',
    paths: ['/bin/sh', '/usr/bin/sh'],
    rcFile: null,
  },
  {
    family: 'bash',
    paths: ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash'],
    rcFile: '~/.bashrc',
  },
  {
    family: 'zsh',
    paths: ['/bin/zsh', '/usr/bin/zsh', '/usr/local/bin/zsh', '/opt/local/bin/zsh', '/opt/homebrew/bin/zsh'],
    rcFile: '~/.zshrc',
  },
  {
    family: 'dash',
    paths: ['/bin/dash', '/usr/bin/dash'],
    rcFile: null,
  },
  {
    family: 'fish',
    paths: ['/bin/fish', '/usr/bin/fish', '/usr/local/bin/fish', '/opt/homebrew/bin/fish'],
    rcFile: null,
  },
];

const SHELL_LAUNCH_SPECS = new Map<string, ShellLaunchSpec>();

for (const familySpec of SHELL_FAMILY_SPECS) {
  for (const shellPath of familySpec.paths) {
    SHELL_LAUNCH_SPECS.set(shellPath, {
      family: familySpec.family,
      shell: shellPath,
      rcFile: familySpec.rcFile,
    });
  }
}

function cloneLaunchSpec(spec: ShellLaunchSpec): ShellLaunchSpec {
  return { ...spec };
}

export function resolveAllowedShellLaunchSpec(
  shellPath: string | undefined,
  existsImpl: ExistsSyncLike = existsSync,
): ShellLaunchSpec | null {
  const normalizedPath = shellPath?.trim();
  if (!normalizedPath) return null;
  const spec = SHELL_LAUNCH_SPECS.get(normalizedPath);
  if (!spec || !existsImpl(normalizedPath)) return null;
  return cloneLaunchSpec(spec);
}

export function resolveFallbackShellLaunchSpec(
  families: ShellFamily[],
  existsImpl: ExistsSyncLike = existsSync,
): ShellLaunchSpec | null {
  for (const family of families) {
    const familySpec = SHELL_FAMILY_SPECS.find((spec) => spec.family === family);
    if (!familySpec) continue;
    for (const shellPath of familySpec.paths) {
      if (!existsImpl(shellPath)) continue;
      const resolved = SHELL_LAUNCH_SPECS.get(shellPath);
      if (resolved) return cloneLaunchSpec(resolved);
    }
  }
  return null;
}

export function resolveDefaultShellLaunchSpec(): ShellLaunchSpec {
  return cloneLaunchSpec(SHELL_LAUNCH_SPECS.get('/bin/sh')!);
}

/**
 * Point zx at a bash on Windows.
 *
 * zx's defaults assume bash: `shell: true` plus a `set -euo pipefail;` prefix.
 * On Windows `shell: true` means cmd.exe, which chokes on that prefix, so every
 * `$` call in git-flow would fail before running anything. GitHub's Windows
 * runners ship Git for Windows, whose bash runs the same commands unchanged
 * (find, which, echo | docker login, …).
 *
 * The explicit path matters: a bare `bash` on PATH can resolve to the WSL stub
 * in System32, which has no distribution behind it on a runner.
 *
 * Imported for its side effect by every library entry point, so the CLI and
 * the actions get it without remembering to call anything. Idempotent.
 */

import { existsSync } from 'node:fs';
import { win32 } from 'node:path';
import { $, quote, useBash } from 'zx';

export interface PlatformShellOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}

/** Candidate Git Bash locations, most specific first. */
export function gitBashCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [env['ProgramFiles'], env['ProgramW6432'], env['ProgramFiles(x86)']]
    .filter((v): v is string => Boolean(v))
    .concat(['C:\\Program Files', 'C:\\Program Files (x86)']);
  const fromRoots = [...new Set(roots)].flatMap((root) => [
    win32.join(root, 'Git', 'bin', 'bash.exe'),
    win32.join(root, 'Git', 'usr', 'bin', 'bash.exe'),
  ]);
  return [env['GITFLOW_BASH'], ...fromRoots].filter((v): v is string => Boolean(v));
}

/**
 * Resolve the shell zx should use on this platform.
 * Returns undefined when the platform default is right (everything but win32).
 */
export function resolvePlatformShell(opts: PlatformShellOptions = {}): string | undefined {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') return undefined;
  const exists = opts.exists ?? existsSync;
  return gitBashCandidates(opts.env ?? process.env).find(exists) ?? 'bash';
}

let configured = false;

export function configurePlatformShell(opts: PlatformShellOptions = {}): void {
  if (configured) return;
  configured = true;
  const shell = resolvePlatformShell(opts);
  if (shell === undefined) return;
  if (shell === 'bash') {
    // No Git for Windows found at a known location; take whatever PATH gives.
    useBash();
    return;
  }
  $.shell = shell;
  // zx picks PowerShell quoting on win32 regardless of shell. Under bash that
  // leaves backslashes in Windows paths unescaped, so `dist\tool` arrives as
  // `dist<TAB>ool`. Use the POSIX quoter, which escapes them.
  $.quote = quote;
}

configurePlatformShell();

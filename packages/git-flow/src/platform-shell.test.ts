import { describe, it, expect } from 'vitest';
import { gitBashCandidates, resolvePlatformShell } from './platform-shell.js';

describe('resolvePlatformShell', () => {
  it('leaves non-Windows platforms on the zx default', () => {
    expect(resolvePlatformShell({ platform: 'linux' })).toBeUndefined();
    expect(resolvePlatformShell({ platform: 'darwin' })).toBeUndefined();
  });

  it('prefers Git for Windows at a known location over a bare `bash`', () => {
    const env = { ProgramFiles: 'C:\\Program Files' };
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    expect(resolvePlatformShell({ platform: 'win32', env, exists: (p) => p === gitBash })).toBe(
      gitBash,
    );
  });

  it('honours GITFLOW_BASH first', () => {
    const env = { GITFLOW_BASH: 'D:\\tools\\bash.exe', ProgramFiles: 'C:\\Program Files' };
    expect(resolvePlatformShell({ platform: 'win32', env, exists: () => true })).toBe(
      'D:\\tools\\bash.exe',
    );
    expect(gitBashCandidates(env)[0]).toBe('D:\\tools\\bash.exe');
  });

  it('falls back to whatever PATH gives when nothing is found', () => {
    expect(resolvePlatformShell({ platform: 'win32', env: {}, exists: () => false })).toBe('bash');
  });
});

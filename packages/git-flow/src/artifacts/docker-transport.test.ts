import { describe, it, expect } from 'vitest';
import { dockerTempTag } from './index.js';
import { isBuildVersion, isGitHubRegistry } from '../publishing/index.js';

describe('dockerTempTag', () => {
  it('derives one tag per commit from the short sha', () => {
    expect(dockerTempTag('818d927c87feb3172d76f7c48308966452f3cc1a')).toBe('temp-818d927');
  });

  it('is stable across re-runs of the same commit and case-insensitive', () => {
    expect(dockerTempTag('818D927C87FEB317')).toBe(dockerTempTag('818d927c87feb317'));
  });

  it('rejects anything that is not a sha', () => {
    expect(() => dockerTempTag('')).toThrow(/expected a commit sha/);
    expect(() => dockerTempTag('latest')).toThrow(/expected a commit sha/);
  });
});

describe('isGitHubRegistry', () => {
  it('recognises ghcr and GitHub Packages, not other hosts', () => {
    expect(isGitHubRegistry({ type: 'docker', registry: 'ghcr.io', auth: 'GITHUB_TOKEN' })).toBe(
      true,
    );
    expect(
      isGitHubRegistry({ type: 'npm', url: 'https://npm.pkg.github.com', auth: 'GITHUB_TOKEN' }),
    ).toBe(true);
    expect(
      isGitHubRegistry({ type: 'docker', registry: 'myregistry.azurecr.io', auth: 'ACR_TOKEN' }),
    ).toBe(false);
  });
});

describe('isBuildVersion', () => {
  it('flags only .build.N versions', () => {
    expect(isBuildVersion('1.2.0-feature.x.build.42')).toBe(true);
    expect(isBuildVersion('1.2.0-alpha.3')).toBe(false);
    expect(isBuildVersion('1.2.0')).toBe(false);
  });
});

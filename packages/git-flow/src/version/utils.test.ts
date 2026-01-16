import { describe, it, expect } from 'vitest';
import {
  isPreRelease,
  sanitizeBranchName,
  isMainlineBranch,
  extractVersionParts,
  buildVersion,
} from './utils.js';

describe('isPreRelease', () => {
  it('should return false for stable versions', () => {
    expect(isPreRelease('2.0.0')).toBe(false);
    expect(isPreRelease('1.8.5')).toBe(false);
  });

  it('should return true for pre-release versions', () => {
    expect(isPreRelease('2.0.0-beta.0')).toBe(true);
    expect(isPreRelease('2.0.0-alpha.1')).toBe(true);
    expect(isPreRelease('2.0.0-main.build.123')).toBe(true);
  });
});

describe('sanitizeBranchName', () => {
  it('should replace slashes with dots', () => {
    expect(sanitizeBranchName('feature/auth')).toBe('feature.auth');
    expect(sanitizeBranchName('team/feature/new')).toBe('team.feature.new');
  });

  it('should handle mainline branches', () => {
    expect(sanitizeBranchName('main')).toBe('main');
    expect(sanitizeBranchName('v1.8')).toBe('v1.8');
  });

  it('should replace special characters', () => {
    expect(sanitizeBranchName('feature@test')).toBe('feature.test');
    expect(sanitizeBranchName('feature#123')).toBe('feature.123');
  });
});

describe('isMainlineBranch', () => {
  it('should return true for mainline branches', () => {
    expect(isMainlineBranch('main')).toBe(true);
    expect(isMainlineBranch('v1.8')).toBe(true);
    expect(isMainlineBranch('develop')).toBe(true);
  });

  it('should return false for development branches', () => {
    expect(isMainlineBranch('feature/auth')).toBe(false);
    expect(isMainlineBranch('team/feature/new')).toBe(false);
  });
});

describe('extractVersionParts', () => {
  it('should extract base and prerelease from version', () => {
    const result = extractVersionParts('2.0.0-beta.0');
    expect(result.base).toBe('2.0.0');
    expect(result.prerelease).toEqual(['beta', '0']);
  });

  it('should handle stable versions', () => {
    const result = extractVersionParts('2.0.0');
    expect(result.base).toBe('2.0.0');
    expect(result.prerelease).toEqual([]);
  });

  it('should handle complex prerelease identifiers', () => {
    const result = extractVersionParts('2.0.0-feature.auth.beta.0');
    expect(result.base).toBe('2.0.0');
    expect(result.prerelease).toEqual(['feature', 'auth', 'beta', '0']);
  });
});

describe('buildVersion', () => {
  it('should build version from parts', () => {
    expect(buildVersion('2.0.0', ['beta', '0'])).toBe('2.0.0-beta.0');
    expect(buildVersion('2.0.0', ['feature', 'auth'])).toBe('2.0.0-feature.auth');
  });

  it('should handle empty prerelease', () => {
    expect(buildVersion('2.0.0', [])).toBe('2.0.0');
  });

  it('should handle complex prerelease', () => {
    expect(buildVersion('2.0.0', ['feature', 'auth', 'beta', '0'])).toBe(
      '2.0.0-feature.auth.beta.0',
    );
  });
});

import { describe, it, expect } from 'vitest';
import { resolveVersion, draftBodyConsumesVersion } from './resolve.js';

// Each test calls resolveVersion which may run `git ls-remote --tags origin`
// (itself capped at 10s). Give tests enough headroom for slow CI networks.
const TEST_TIMEOUT = 30_000;

describe('resolveVersion - Mainline Branches', { timeout: TEST_TIMEOUT }, () => {
  const versionsByPlaceholder = {
    '0.0.0-DEFAULT': '2.0.0',
    '0.0.0-V1_8_LTS': '1.8.5',
    '0.0.0-BETA': '2.0.0-beta.0',
  };

  describe('Scenario 1: First release from main (no tag)', () => {
    it('should return resolved version as-is', async () => {
      const result = await resolveVersion({
        placeholder: '0.0.0-DEFAULT',
        branch: 'main',
        versionsByPlaceholder,
        runNumber: 123,
      });

      expect(result.version).toBe('2.0.0');
      expect(result.isPreRelease).toBe(false);
      expect(result.buildNumber).toBeUndefined();
      expect(result.branchType).toBe('mainline');
    });
  });

  describe('Pre-release versions on mainline', () => {
    it('should handle pre-release placeholder without tag', async () => {
      const result = await resolveVersion({
        placeholder: '0.0.0-BETA',
        branch: 'main',
        versionsByPlaceholder,
        runNumber: 42,
      });

      expect(result.version).toBe('2.0.0-beta.0');
      expect(result.isPreRelease).toBe(true);
      expect(result.buildNumber).toBeUndefined();
      expect(result.branchType).toBe('mainline');
    });
  });

  describe('LTS branch (v1.8)', () => {
    it('should handle version branch without tag', async () => {
      const result = await resolveVersion({
        placeholder: '0.0.0-V1_8_LTS',
        branch: 'v1.8',
        versionsByPlaceholder,
        runNumber: 123,
      });

      expect(result.version).toBe('1.8.5');
      expect(result.isPreRelease).toBe(false);
      expect(result.buildNumber).toBeUndefined();
      expect(result.branchType).toBe('mainline');
    });
  });
});

describe('resolveVersion - Development Branches', { timeout: TEST_TIMEOUT }, () => {
  const versionsByPlaceholder = {
    '0.0.0-DEFAULT': '2.0.0',
    '0.0.0-BETA': '2.0.0-beta.0',
  };

  describe('Scenario: Development branch with stable version (no tag)', () => {
    it('should append branch name as prerelease', async () => {
      const result = await resolveVersion({
        placeholder: '0.0.0-DEFAULT',
        branch: 'feature/auth',
        versionsByPlaceholder,
        runNumber: 123,
      });

      expect(result.version).toBe('2.0.0-feature.auth');
      expect(result.isPreRelease).toBe(true);
      expect(result.buildNumber).toBeUndefined();
      expect(result.branchType).toBe('development');
    });
  });

  describe('Scenario: Development branch with pre-release version (no tag)', () => {
    it('should insert branch before prerelease identifier', async () => {
      const result = await resolveVersion({
        placeholder: '0.0.0-BETA',
        branch: 'feature/auth',
        versionsByPlaceholder,
        runNumber: 42,
      });

      expect(result.version).toBe('2.0.0-feature.auth.beta.0');
      expect(result.isPreRelease).toBe(true);
      expect(result.buildNumber).toBeUndefined();
      expect(result.branchType).toBe('development');
    });
  });

  describe('Branch name sanitization', () => {
    it('should sanitize complex branch names', async () => {
      const result = await resolveVersion({
        placeholder: '0.0.0-DEFAULT',
        branch: 'team/feature/new-thing',
        versionsByPlaceholder,
      });

      expect(result.version).toBe('2.0.0-team.feature.new-thing');
    });
  });
});

describe('resolveVersion - Edge Cases', { timeout: TEST_TIMEOUT }, () => {
  it('should throw error for missing placeholder', async () => {
    await expect(
      resolveVersion({
        placeholder: '0.0.0-UNKNOWN',
        branch: 'main',
        versionsByPlaceholder: {},
      }),
    ).rejects.toThrow('No version found for placeholder: 0.0.0-UNKNOWN');
  });

  it('should handle missing runNumber', async () => {
    const result = await resolveVersion({
      placeholder: '0.0.0-DEFAULT',
      branch: 'main',
      versionsByPlaceholder: { '0.0.0-DEFAULT': '2.0.0' },
    });

    expect(result.version).toBe('2.0.0');
  });

  it('should handle runNumber 0', async () => {
    const result = await resolveVersion({
      placeholder: '0.0.0-DEFAULT',
      branch: 'main',
      versionsByPlaceholder: { '0.0.0-DEFAULT': '2.0.0' },
      runNumber: 0,
    });

    expect(result.version).toBe('2.0.0');
  });
});

describe('resolveVersion - Quick Lookup Table Examples', { timeout: TEST_TIMEOUT }, () => {
  const versionsByPlaceholder = {
    '0.0.0-DEFAULT': '2.0.0',
    '0.0.0-V1_8_LTS': '1.8.5',
    '0.0.0-BETA': '2.0.0-beta.0',
  };

  it('Row 1: Mainline main, 2.0.0, no tag', async () => {
    const result = await resolveVersion({
      placeholder: '0.0.0-DEFAULT',
      branch: 'main',
      versionsByPlaceholder,
    });
    expect(result.version).toBe('2.0.0');
    expect(result.isPreRelease).toBe(false);
  });

  it('Row 3: Mainline main, 2.0.0-beta.0, no tag', async () => {
    const result = await resolveVersion({
      placeholder: '0.0.0-BETA',
      branch: 'main',
      versionsByPlaceholder,
    });
    expect(result.version).toBe('2.0.0-beta.0');
    expect(result.isPreRelease).toBe(true);
  });

  it('Row 5: Mainline v1.8, 1.8.5, no tag', async () => {
    const result = await resolveVersion({
      placeholder: '0.0.0-V1_8_LTS',
      branch: 'v1.8',
      versionsByPlaceholder,
    });
    expect(result.version).toBe('1.8.5');
    expect(result.isPreRelease).toBe(false);
  });

  it('Row 7: Development feature/auth, 2.0.0, no tag', async () => {
    const result = await resolveVersion({
      placeholder: '0.0.0-DEFAULT',
      branch: 'feature/auth',
      versionsByPlaceholder,
    });
    expect(result.version).toBe('2.0.0-feature.auth');
    expect(result.isPreRelease).toBe(true);
  });

  it('Row 9: Development feature/auth, 2.0.0-beta.0, no tag', async () => {
    const result = await resolveVersion({
      placeholder: '0.0.0-BETA',
      branch: 'feature/auth',
      versionsByPlaceholder,
    });
    expect(result.version).toBe('2.0.0-feature.auth.beta.0');
    expect(result.isPreRelease).toBe(true);
  });
});

describe('draftBodyConsumesVersion', () => {
  const wrap = (yaml: string) =>
    `📋 **Created from PR:** #102\n\n## Artifact Metadata\n\`\`\`yaml\n${yaml}\n\`\`\`\n`;

  it('a fully-published draft is still resumable — the tag, not the draft, consumes the version', () => {
    // The shop-in-shop 0.8.0-alpha.0 incident: npm+nuget published, docker
    // bundle failed, next release PR bumped everything to .build.N.
    expect(
      draftBodyConsumesVersion(
        wrap('project: "@x/spec"\nartifacts:\n  - type: ng-lib\n    published: true'),
      ),
    ).toBe(false);
  });

  it('a partially-published draft is resumable', () => {
    expect(
      draftBodyConsumesVersion(
        wrap(
          'project: "@x/svc"\nartifacts:\n  - type: docker-image\n    published: false\n  - type: deploy\n    published: true',
        ),
      ),
    ).toBe(false);
  });

  it('an unpublished draft is resumable', () => {
    expect(
      draftBodyConsumesVersion(
        wrap('project: "@x/svc"\nartifacts:\n  - type: docker-image\n    published: false'),
      ),
    ).toBe(false);
  });

  it('a legacy draft with artifacts but no published flags is consumed', () => {
    expect(
      draftBodyConsumesVersion(wrap('project: "@x/svc"\nartifacts:\n  - type: docker-image')),
    ).toBe(true);
  });

  it('a body without a yaml block proves nothing', () => {
    expect(draftBodyConsumesVersion('just some prose')).toBe(false);
  });
});

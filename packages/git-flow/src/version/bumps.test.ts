import { describe, it, expect } from 'vitest';
import * as semver from 'semver';
import { computeBumpOptions } from './bumps.js';

/** The declared ladder, recovered from the channel-upgrade options of an alpha version. */
function declaredLadder(): string[] {
  const upgrades = computeBumpOptions('1.2.3-alpha.0')
    .filter((o) => o.id.startsWith('channel-'))
    .map((o) => o.id.replace('channel-', ''));
  return ['alpha', ...upgrades];
}

describe('CHANNEL_ORDER', () => {
  it('is ordered ascending by semver, not just by intent', () => {
    const ladder = declaredLadder();
    const versions = ladder.map((c) => `1.0.0-${c}.0`);
    expect([...versions].sort(semver.compare)).toEqual(versions);
  });

  it('places every channel below the stable release', () => {
    for (const channel of declaredLadder()) {
      expect(semver.lt(`1.0.0-${channel}.0`, '1.0.0')).toBe(true);
    }
  });

  it('does not offer the retired dev channel', () => {
    expect(declaredLadder()).not.toContain('dev');
  });
});

describe('computeBumpOptions', () => {
  it('starts new pre-releases in the alpha channel', () => {
    const patch = computeBumpOptions('1.2.3').find((o) => o.id === 'patch');
    expect(patch?.result).toBe('1.2.4-alpha.0');
  });

  it('offers beta and rc upgrades from alpha, and none from rc', () => {
    expect(declaredLadder()).toEqual(['alpha', 'beta', 'rc']);
    const fromRc = computeBumpOptions('1.2.3-rc.0').filter((o) => o.id.startsWith('channel-'));
    expect(fromRc).toEqual([]);
  });

  it('still increments a legacy dev version rather than stranding it', () => {
    const next = computeBumpOptions('1.2.3-dev.4').find((o) => o.id === 'next');
    expect(next?.result).toBe('1.2.3-dev.5');
  });
});

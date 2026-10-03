import { describe, it, expect } from 'vitest';
import { floatingTagOwners, planRestoreRepoints, planWithdrawRepoints } from './effects.js';
import { isForceableKind, KIND_INFO, WITHDRAW_KINDS } from './types.js';

describe('floatingTagOwners', () => {
  it('names the highest stable, the highest overall and the highest per channel', () => {
    expect(floatingTagOwners(['1.4.0', '1.4.1', '1.5.0-beta.1', '1.5.0-rc.0'])).toEqual({
      latest: '1.4.1',
      next: '1.5.0-rc.0',
      beta: '1.5.0-beta.1',
      rc: '1.5.0-rc.0',
    });
  });

  it('ignores ineligible versions', () => {
    expect(floatingTagOwners(['1.4.1', '1.4.2-feature-x.build.3', '1.4.2.build.9'])).toEqual({
      latest: '1.4.1',
      next: '1.4.1',
    });
  });

  it('is empty when nothing is eligible', () => {
    expect(floatingTagOwners([])).toEqual({});
  });
});

describe('planWithdrawRepoints', () => {
  it('moves the pointers the withdrawn version holds to the next eligible version', () => {
    expect(planWithdrawRepoints('1.4.2', ['1.4.0', '1.4.1', '1.5.0-beta.1'])).toEqual([
      { tag: 'latest', to: '1.4.1' },
    ]);
  });

  it('includes next when the withdrawn version was the highest overall', () => {
    expect(planWithdrawRepoints('1.5.0', ['1.4.1', '1.5.0-rc.1'])).toEqual([
      { tag: 'latest', to: '1.4.1' },
      { tag: 'next', to: '1.5.0-rc.1' },
    ]);
  });

  it('removes a channel pointer when the withdrawn version was its only member', () => {
    expect(planWithdrawRepoints('1.5.0-rc.0', ['1.4.1'])).toEqual([
      { tag: 'next', to: '1.4.1' },
      { tag: 'rc', to: undefined },
    ]);
  });

  it('moves nothing when the withdrawn version held nothing', () => {
    expect(planWithdrawRepoints('1.4.0', ['1.4.1', '1.4.2'])).toEqual([]);
    expect(planWithdrawRepoints('1.4.1-x.build.2', ['1.4.1'])).toEqual([]);
  });

  it('already-withdrawn siblings are not candidates (caller filters them out)', () => {
    // 1.4.1 withdrawn earlier → caller passes others without it.
    expect(planWithdrawRepoints('1.4.2', ['1.4.0'])).toEqual([
      { tag: 'latest', to: '1.4.0' },
      { tag: 'next', to: '1.4.0' },
    ]);
  });
});

describe('planRestoreRepoints', () => {
  it('gives the restored version back the pointers it earns', () => {
    expect(planRestoreRepoints('1.4.2', ['1.4.0', '1.4.1'])).toEqual([
      { tag: 'latest', to: '1.4.2' },
      { tag: 'next', to: '1.4.2' },
    ]);
    expect(planRestoreRepoints('1.4.0', ['1.4.1'])).toEqual([]);
  });
});

describe('kinds', () => {
  it('every kind has defaults and only rollback-safe kinds are forceable', () => {
    for (const k of WITHDRAW_KINDS) expect(KIND_INFO[k].summary.length).toBeGreaterThan(0);
    expect(WITHDRAW_KINDS.filter(isForceableKind)).toEqual(['obsolete', 'superseded', 'temporary']);
    expect(isForceableKind('made-up')).toBe(false);
  });
});

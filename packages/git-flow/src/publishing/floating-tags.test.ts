import { describe, expect, it } from 'vitest';
import { channelOf, computeFloatingTags, isFloatingEligible } from './floating-tags.js';

describe('isFloatingEligible', () => {
  it('accepts stable and channel prereleases', () => {
    expect(isFloatingEligible('2.0.0')).toBe(true);
    expect(isFloatingEligible('2.1.0-alpha.0')).toBe(true);
    expect(isFloatingEligible('2.1.0-beta.12')).toBe(true);
    expect(isFloatingEligible('2.1.0-rc.1')).toBe(true);
  });

  it('rejects build, development-branch and unknown-channel versions', () => {
    expect(isFloatingEligible('2.1.0-main.build.42')).toBe(false);
    expect(isFloatingEligible('2.1.0-rc.1.build.42')).toBe(false);
    expect(isFloatingEligible('2.0.0-feature.auth')).toBe(false);
    expect(isFloatingEligible('2.0.0-feature.auth.beta.0')).toBe(false);
    expect(isFloatingEligible('2.2.0-dev.0')).toBe(false);
    expect(isFloatingEligible('2.1.0-alpha')).toBe(false);
    expect(isFloatingEligible('not-a-version')).toBe(false);
  });

  it('reads the channel of eligible prereleases only', () => {
    expect(channelOf('2.1.0-alpha.3')).toBe('alpha');
    expect(channelOf('2.1.0')).toBeUndefined();
    expect(channelOf('2.0.0-feature.auth.beta.0')).toBeUndefined();
  });
});

describe('computeFloatingTags', () => {
  it('a new highest stable takes latest and next', () => {
    expect(computeFloatingTags('2.0.0', ['1.9.0', '2.0.0-rc.1'])).toEqual(['latest', 'next']);
  });

  it('a maintenance patch behind a newer line moves nothing', () => {
    expect(computeFloatingTags('1.8.5', ['1.8.4', '2.0.0', '2.1.0-alpha.0'])).toEqual([]);
  });

  it('a prerelease above the newest stable takes next and its channel', () => {
    expect(computeFloatingTags('2.1.0-alpha.1', ['2.0.0', '2.1.0-alpha.0'])).toEqual([
      'next',
      'alpha',
    ]);
  });

  it('an older prerelease of a channel moves nothing', () => {
    expect(computeFloatingTags('2.1.0-alpha.0', ['2.0.0', '2.1.0-alpha.1'])).toEqual([]);
  });

  it('a stable release leaves the channel pointers alone', () => {
    expect(computeFloatingTags('2.1.0', ['2.0.0', '2.1.0-alpha.3', '2.1.0-rc.0'])).toEqual([
      'latest',
      'next',
    ]);
  });

  it('channels are independent', () => {
    expect(computeFloatingTags('2.1.0-rc.0', ['2.0.0', '2.1.0-beta.3'])).toEqual(['next', 'rc']);
    expect(computeFloatingTags('2.1.0-beta.4', ['2.0.0', '2.1.0-beta.3', '2.1.0-rc.0'])).toEqual([
      'beta',
    ]);
  });

  it('the version itself need not be in the existing list', () => {
    expect(computeFloatingTags('1.0.0', [])).toEqual(['latest', 'next']);
    expect(computeFloatingTags('1.0.0-alpha.0', [])).toEqual(['next', 'alpha']);
  });

  it('ineligible versions earn nothing and are ignored as competitors', () => {
    expect(computeFloatingTags('2.1.0-main.build.42', ['2.0.0'])).toEqual([]);
    expect(computeFloatingTags('2.0.0-feature.auth.beta.0', ['1.0.0'])).toEqual([]);
    // A dev-branch build with a higher base does not block the mainline pointer.
    expect(computeFloatingTags('2.0.0', ['3.0.0-feature.auth', '2.1.0-main.build.7'])).toEqual([
      'latest',
      'next',
    ]);
  });

  it('next is never below latest', () => {
    const versions = ['1.0.0', '1.1.0-alpha.0', '1.1.0', '1.2.0-beta.0', '2.0.0-rc.0', '2.0.0'];
    for (const v of versions) {
      const tags = computeFloatingTags(v, versions);
      if (tags.includes('latest')) expect(tags).toContain('next');
    }
  });
});

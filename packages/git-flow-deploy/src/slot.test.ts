import { describe, it, expect } from 'vitest';
import { safeName, majorVersion, deploymentSlot, slotStack } from './slot.js';

describe('safeName', () => {
  it('strips @ and replaces / with -', () => {
    expect(safeName('@cpdevtools/git-flow-deploy-service')).toBe(
      'cpdevtools-git-flow-deploy-service',
    );
  });

  it('leaves an unscoped name mostly intact', () => {
    expect(safeName('my-service')).toBe('my-service');
  });
});

describe('majorVersion', () => {
  it('extracts the major number', () => {
    expect(majorVersion('1.2.3')).toBe(1);
    expect(majorVersion('2.0.0')).toBe(2);
    expect(majorVersion('0.4.11')).toBe(0);
  });

  it('handles a leading v and pre-release suffixes', () => {
    expect(majorVersion('v3.1.0')).toBe(3);
    expect(majorVersion('4.0.0-dev.5')).toBe(4);
  });

  it('returns 0 for unparseable input', () => {
    expect(majorVersion('not-a-version')).toBe(0);
  });
});

describe('deploymentSlot', () => {
  it('defaults to singleton (name only)', () => {
    expect(deploymentSlot('@org/svc', '1.2.3')).toBe('org-svc');
  });

  it('singleton ignores the version', () => {
    expect(deploymentSlot('@org/svc', '1.2.3', 'singleton')).toBe('org-svc');
    expect(deploymentSlot('@org/svc', '2.0.0', 'singleton')).toBe('org-svc');
  });

  it('major appends -v<major>', () => {
    expect(deploymentSlot('@org/svc', '1.2.3', 'major')).toBe('org-svc-v1');
    expect(deploymentSlot('@org/svc', '2.3.5', 'major')).toBe('org-svc-v2');
  });

  it('major shares a slot across patches/minors of the same major', () => {
    expect(deploymentSlot('@org/svc', '1.2.4', 'major')).toBe(
      deploymentSlot('@org/svc', '1.5.0', 'major'),
    );
  });
});

describe('slotStack', () => {
  it('replaces hyphens with underscores', () => {
    expect(slotStack('org-svc-v1')).toBe('org_svc_v1');
  });
});

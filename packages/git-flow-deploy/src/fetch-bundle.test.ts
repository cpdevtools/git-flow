import { describe, it, expect } from 'vitest';
import {
  FORCEABLE_WITHDRAW_KINDS,
  readReleaseWithdrawal,
  WithdrawnReleaseError,
} from './fetch-bundle.js';

const body = (kind: string) => `notes

## Artifact Metadata
\`\`\`yaml
project: "@org/svc"
withdrawn:
  kind: ${kind}
  reason: why
  replacedBy: 1.4.3
artifacts: []
\`\`\``;

describe('readReleaseWithdrawal', () => {
  it('reads the marker from the metadata block', () => {
    expect(readReleaseWithdrawal(body('broken'))).toEqual({
      kind: 'broken',
      reason: 'why',
      replacedBy: '1.4.3',
    });
  });

  it('is undefined without a marker or without metadata', () => {
    expect(readReleaseWithdrawal('## Artifact Metadata\n```yaml\nproject: x\n```')).toBeUndefined();
    expect(readReleaseWithdrawal(null)).toBeUndefined();
    expect(readReleaseWithdrawal('plain')).toBeUndefined();
  });
});

describe('WithdrawnReleaseError', () => {
  it('says whether --force can help', () => {
    const w = { kind: 'obsolete', reason: 'old', replacedBy: '2.0.0' };
    const forceable = new WithdrawnReleaseError(7, w, FORCEABLE_WITHDRAW_KINDS.includes(w.kind));
    expect(forceable.message).toMatch(
      /WITHDRAWN \(obsolete\): old — use 2.0.0 instead\. Pass --force/,
    );
    const never = new WithdrawnReleaseError(8, { kind: 'security', reason: 'cve' }, false);
    expect(never.message).toMatch(/can never be forced/);
    expect(never.name).toBe('WithdrawnReleaseError');
  });
});

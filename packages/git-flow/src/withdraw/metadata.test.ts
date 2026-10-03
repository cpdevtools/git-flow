import { describe, it, expect } from 'vitest';
import {
  readWithdrawal,
  restoredTitle,
  setWithdrawalInBody,
  withdrawnTitle,
  WITHDRAWN_TITLE_PREFIX,
} from './metadata.js';
import type { Withdrawal } from './types.js';

const BODY = `## Release notes

Some text.

## Artifact Metadata
\`\`\`yaml
project: "@org/orders"
branch: main
artifacts:
  - type: npm
    name: "@org/orders"
    registries:
      - github-npm
    published: true
\`\`\``;

const W: Withdrawal = {
  kind: 'broken',
  reason: 'double-charges orders with a discount code',
  at: '2026-10-03T19:12:00Z',
  by: 'erd',
};

describe('withdrawal marker', () => {
  it('is absent on an ordinary release', () => {
    expect(readWithdrawal(BODY)).toBeUndefined();
    expect(readWithdrawal(null)).toBeUndefined();
    expect(readWithdrawal('no metadata here')).toBeUndefined();
  });

  it('writes the marker into the metadata block and a banner on top', () => {
    const marked = setWithdrawalInBody(BODY, W);
    expect(marked.startsWith('<!-- gitflow:withdrawn -->')).toBe(true);
    expect(marked).toContain('⛔ **WITHDRAWN (broken)** — double-charges');
    expect(readWithdrawal(marked)).toEqual(W);
    // The rest of the metadata is untouched.
    expect(marked).toContain('published: true');
    expect(marked).toContain('## Release notes');
  });

  it('round-trips optional fields and re-marking replaces rather than duplicates', () => {
    const first = setWithdrawalInBody(BODY, W);
    const second = setWithdrawalInBody(first, {
      ...W,
      kind: 'superseded',
      replacedBy: '1.4.3',
      registry: 'marked',
      assets: 'kept',
    });
    expect(second.match(/<!-- gitflow:withdrawn -->/g)).toHaveLength(1);
    expect(second.match(/withdrawn:/g)).toHaveLength(1);
    expect(readWithdrawal(second)).toMatchObject({
      kind: 'superseded',
      replacedBy: '1.4.3',
      registry: 'marked',
    });
    expect(second).toContain('Use **1.4.3** instead');
  });

  it('clears the marker and banner on restore, leaving the body as it was', () => {
    const marked = setWithdrawalInBody(BODY, W);
    const restored = setWithdrawalInBody(marked, null);
    expect(readWithdrawal(restored)).toBeUndefined();
    expect(restored).not.toContain('gitflow:withdrawn');
    expect(restored.trim()).toBe(BODY.trim());
  });

  it('refuses a body without a metadata block', () => {
    expect(() => setWithdrawalInBody('plain notes', W)).toThrow(/no "## Artifact Metadata"/);
  });

  it('prefixes and strips the title idempotently', () => {
    expect(withdrawnTitle('@org/orders 1.4.2')).toBe(`${WITHDRAWN_TITLE_PREFIX}@org/orders 1.4.2`);
    expect(withdrawnTitle(withdrawnTitle('x'))).toBe(`${WITHDRAWN_TITLE_PREFIX}x`);
    expect(restoredTitle(`${WITHDRAWN_TITLE_PREFIX}x`)).toBe('x');
    expect(restoredTitle('x')).toBe('x');
  });
});

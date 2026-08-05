import { describe, it, expect } from 'vitest';
import { signRequest, validateHmac, validateTimestamp } from './hmac.js';

// Frozen wire format: actions/deploy and the C# gateway both depend on these exact values.
const VECTORS: [secret: string, ts: string, body: string, sig: string][] = [
  [
    'test-secret-key',
    '1700000000',
    '{"repo":"owner/repo","release_id":123}',
    'sha256=0a30717fedbe786a8ea43d3d2083b9da53076933ce2449ed33ba6a58c3c3def1',
  ],
  [
    'test-secret-key',
    '1700000000',
    '',
    'sha256=c19c10621ef583ec3522b3676a637812a0703bfd7bb33c17a04b47a9262e4968',
  ],
  [
    'ünicode-sécret',
    '1735689600',
    '{"repo":"öwner/répo","release_id":1}',
    'sha256=c9c71cfa54c30900f8d124a03b2a2ab15a2df8c0b9973d3626003f1569088377',
  ],
  ['s', '0', '.', 'sha256=25c080d9a144dfe11166778578443d37a4c8d6c563410ac2751e64803c027f28'],
];

describe('signRequest', () => {
  it.each(VECTORS)('matches the frozen vector for %s/%s', (secret, ts, body, sig) => {
    expect(signRequest(secret, ts, body)).toBe(sig);
  });

  it('signs a Buffer identically to the equivalent string', () => {
    for (const [secret, ts, body, sig] of VECTORS) {
      expect(signRequest(secret, ts, Buffer.from(body, 'utf8'))).toBe(sig);
    }
  });
});

describe('validateHmac', () => {
  it('accepts a matching signature', () => {
    expect(validateHmac('secret', signRequest('secret', '1700000000', 'body'), '1700000000', 'body')).toBe(true);
  });

  it.each([
    ['wrong secret', 'other', signRequest('secret', '1700000000', 'body'), '1700000000', 'body'],
    ['tampered body', 'secret', signRequest('secret', '1700000000', 'body'), '1700000000', 'evil'],
    ['tampered timestamp', 'secret', signRequest('secret', '1700000000', 'body'), '1700000001', 'body'],
    ['empty signature', 'secret', '', '1700000000', 'body'],
    ['unprefixed digest', 'secret', signRequest('secret', '1700000000', 'body').slice(7), '1700000000', 'body'],
  ])('rejects %s', (_label, secret, signature, ts, body) => {
    expect(validateHmac(secret, signature, ts, body)).toBe(false);
  });
});

describe('validateTimestamp', () => {
  const now = () => String(Math.floor(Date.now() / 1000));

  it('accepts a current timestamp and rejects one outside the window', () => {
    expect(validateTimestamp(now())).toBe(true);
    expect(validateTimestamp(String(Number(now()) - 30))).toBe(true);
    expect(validateTimestamp(String(Number(now()) + 30))).toBe(true);
    expect(validateTimestamp(String(Number(now()) - 120))).toBe(false);
    expect(validateTimestamp(String(Number(now()) + 120))).toBe(false);
  });

  it('honours a custom window', () => {
    expect(validateTimestamp(String(Number(now()) - 120), 300)).toBe(true);
  });

  // The payload is "<ts>.<body>", so a fractional timestamp would let
  // ts="1.2"/body="3" and ts="1"/body="2.3" sign identically.
  it.each(['', 'not-a-number', '1700000000.5', '1700000000abc', ' 1700000000', '0x1'])(
    'rejects the non-integer timestamp %o',
    (ts) => {
      expect(validateTimestamp(ts)).toBe(false);
    },
  );
});

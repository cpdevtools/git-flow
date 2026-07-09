import { signRequest, validateHmac, validateTimestamp } from '@cpdevtools/git-flow-deploy';

describe('HMAC helpers', () => {
  const secret = 'test-secret-key';
  const body = '{"repo":"owner/repo","release_id":123}';

  it('signRequest produces a sha256= prefixed signature', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signRequest(secret, ts, body);
    expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it('signRequest + validateHmac roundtrip passes', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signRequest(secret, ts, body);
    expect(validateHmac(secret, sig, ts, body)).toBe(true);
  });

  it('validateHmac rejects wrong secret', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signRequest(secret, ts, body);
    expect(validateHmac('wrong-secret', sig, ts, body)).toBe(false);
  });

  it('validateHmac rejects tampered body', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signRequest(secret, ts, body);
    expect(validateHmac(secret, sig, ts, '{"repo":"evil/repo","release_id":999}')).toBe(false);
  });

  it('validateHmac rejects tampered timestamp', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signRequest(secret, ts, body);
    expect(validateHmac(secret, sig, String(Number(ts) + 1), body)).toBe(false);
  });

  it('validateTimestamp accepts current time', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    expect(validateTimestamp(ts)).toBe(true);
  });

  it('validateTimestamp accepts time within window', () => {
    const ts = String(Math.floor(Date.now() / 1000) - 30);
    expect(validateTimestamp(ts)).toBe(true);
  });

  it('validateTimestamp rejects stale timestamp (>60s old)', () => {
    const ts = String(Math.floor(Date.now() / 1000) - 120);
    expect(validateTimestamp(ts)).toBe(false);
  });

  it('validateTimestamp rejects future timestamp beyond window', () => {
    const ts = String(Math.floor(Date.now() / 1000) + 120);
    expect(validateTimestamp(ts)).toBe(false);
  });

  it('validateTimestamp rejects non-numeric string', () => {
    expect(validateTimestamp('not-a-number')).toBe(false);
  });
});

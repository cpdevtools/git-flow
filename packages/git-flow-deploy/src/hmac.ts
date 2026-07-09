import { createHmac, timingSafeEqual } from 'node:crypto';

const HMAC_ALGO = 'sha256';
const SIG_PREFIX = 'sha256=';

function computeHmac(secret: string, ts: string, rawBody: string): string {
  return SIG_PREFIX + createHmac(HMAC_ALGO, secret).update(`${ts}.${rawBody}`).digest('hex');
}

/**
 * Sign a request body for use as X-Deploy-Signature-256.
 */
export function signRequest(secret: string, ts: string, rawBody: string): string {
  return computeHmac(secret, ts, rawBody);
}

/**
 * Validate an incoming X-Deploy-Signature-256 value against the raw body.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function validateHmac(secret: string, signature: string, ts: string, rawBody: string): boolean {
  const expected = computeHmac(secret, ts, rawBody);
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * Validate that a unix-seconds timestamp is within the allowed window.
 */
export function validateTimestamp(ts: string, windowSeconds = 60): boolean {
  const t = parseInt(ts, 10);
  if (isNaN(t)) return false;
  const now = Math.floor(Date.now() / 1000);
  return Math.abs(now - t) <= windowSeconds;
}

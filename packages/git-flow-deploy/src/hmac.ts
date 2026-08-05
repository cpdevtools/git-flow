import { createHmac, timingSafeEqual } from 'node:crypto';

const HMAC_ALGO = 'sha256';
const SIG_PREFIX = 'sha256=';

export const SIGNATURE_HEADER = 'X-Deploy-Signature-256';
export const TIMESTAMP_HEADER = 'X-Deploy-Timestamp';
export const DEFAULT_TIMESTAMP_WINDOW_SECONDS = 60;

/** Buffers are hashed as-is so a body is signed as the exact bytes received. */
function computeHmac(secret: string, ts: string, rawBody: string | Buffer): string {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
  const payload = Buffer.concat([Buffer.from(`${ts}.`, 'utf8'), body]);
  return SIG_PREFIX + createHmac(HMAC_ALGO, secret).update(payload).digest('hex');
}

/**
 * Sign a request body for use as X-Deploy-Signature-256.
 */
export function signRequest(secret: string, ts: string, rawBody: string | Buffer): string {
  return computeHmac(secret, ts, rawBody);
}

/**
 * Validate an incoming X-Deploy-Signature-256 value against the raw body.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function validateHmac(
  secret: string,
  signature: string,
  ts: string,
  rawBody: string | Buffer,
): boolean {
  const expected = computeHmac(secret, ts, rawBody);
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * Validate that a unix-seconds timestamp is within the allowed window.
 *
 * Integer-only: the signed payload joins timestamp and body with '.', so a
 * fractional timestamp would make "1.2" + "3" and "1" + "2.3" sign identically.
 */
export function validateTimestamp(
  ts: string,
  windowSeconds = DEFAULT_TIMESTAMP_WINDOW_SECONDS,
): boolean {
  if (!/^-?\d+$/.test(ts)) return false;
  const t = Number(ts);
  if (!Number.isSafeInteger(t)) return false;
  const now = Math.floor(Date.now() / 1000);
  return Math.abs(now - t) <= windowSeconds;
}

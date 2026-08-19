import { describe, it, expect, vi } from 'vitest';
import { isTransientRegistryError, dockerPushWithRetry } from './publishers.js';

describe('isTransientRegistryError', () => {
  it('treats the GHCR secondary-rate-limit 403 as transient', () => {
    const output =
      'denied: permission_denied: Error from intermediary with HTTP status code 403 ' +
      '"Forbidden" - with-body: { "message": "You have exceeded a secondary rate limit. ' +
      'Please wait a few minutes before you try again." }';
    expect(isTransientRegistryError(output)).toBe(true);
  });

  it('treats a GHCR mid-push BLOB_UNKNOWN as transient', () => {
    // Observed on shop-in-shop's first image publish: several layers Pushed /
    // "Layer already exists", then one blob fails with a bare "unknown blob".
    const output =
      'The push refers to repository [ghcr.io/idealsupply/webservice-shop-in-shop]\n' +
      '5f432f4a79d4: Pushed\n5f70bf18a086: Layer already exists\nunknown blob';
    expect(isTransientRegistryError(output)).toBe(true);
  });

  it.each([
    'toomanyrequests: too many requests',
    'received unexpected HTTP status code 429',
    'received unexpected HTTP status code 503 Service Unavailable',
    'net/http: TLS handshake timeout',
    'read tcp: connection reset by peer',
    'unexpected EOF',
  ])('classifies %j as transient', (output) => {
    expect(isTransientRegistryError(output)).toBe(true);
  });

  it.each([
    'denied: installation not allowed to access this resource',
    'unauthorized: authentication required',
    'name unknown: repository name not known to registry',
    'manifest invalid',
  ])('classifies %j as NOT transient', (output) => {
    expect(isTransientRegistryError(output)).toBe(false);
  });
});

describe('dockerPushWithRetry', () => {
  it('returns after the first successful attempt', async () => {
    const push = vi.fn().mockResolvedValue({ exitCode: 0, output: '' });
    const sleep = vi.fn().mockResolvedValue(undefined);

    await dockerPushWithRetry('ghcr.io/org/img:1.0.0', { push, sleep });

    expect(push).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a transient failure and then succeeds', async () => {
    const push = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 1, output: 'You have exceeded a secondary rate limit.' })
      .mockResolvedValueOnce({ exitCode: 1, output: 'HTTP status code 503' })
      .mockResolvedValueOnce({ exitCode: 0, output: '' });
    const sleep = vi.fn().mockResolvedValue(undefined);

    await dockerPushWithRetry('ghcr.io/org/img:1.0.0', { push, sleep });

    expect(push).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('fails immediately on a non-transient error (no waiting)', async () => {
    const push = vi
      .fn()
      .mockResolvedValue({ exitCode: 1, output: 'unauthorized: authentication required' });
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(dockerPushWithRetry('ghcr.io/org/img:1.0.0', { push, sleep })).rejects.toThrow(
      /docker push .* failed/,
    );

    expect(push).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives up after exhausting retries on a persistent transient error', async () => {
    const push = vi
      .fn()
      .mockResolvedValue({ exitCode: 1, output: 'You have exceeded a secondary rate limit.' });
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      dockerPushWithRetry('ghcr.io/org/img:1.0.0', { push, sleep, retries: 3 }),
    ).rejects.toThrow(/secondary rate limit/);

    // Initial attempt + 3 retries = 4 pushes; sleeps between them = 3.
    expect(push).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });
});

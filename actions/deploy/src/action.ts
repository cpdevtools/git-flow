import * as core from '@actions/core';
import { createHmac } from 'node:crypto';
import { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { URL } from 'node:url';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const repo = process.env['INPUT_REPO'] ?? '';
const releaseId = parseInt(process.env['INPUT_RELEASE_ID'] ?? '', 10);
const deployUrl = (process.env['INPUT_DEPLOY_URL'] ?? '').replace(/\/$/, '');
const deployToken = process.env['INPUT_DEPLOY_TOKEN'] ?? '';

if (!repo || isNaN(releaseId) || !deployUrl || !deployToken) {
  core.setFailed('Missing required inputs: repo, release_id, deploy_url, deploy_token');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// HMAC helpers (self-contained — no workspace dep needed)
// ---------------------------------------------------------------------------
function signRequest(secret: string, ts: string, rawBody: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function makeRequest(
  urlStr: string,
  options: { method: string; headers: Record<string, string>; body?: string },
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = lib(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: options.method,
        headers: options.headers,
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }),
        );
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * Stream GET response line by line.
 * Returns a promise that resolves once the server closes the connection or the
 * done callback returns true.
 */
function streamLines(
  urlStr: string,
  headers: Record<string, string>,
  onLine: (line: string) => boolean, // return true = stop
): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = lib(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'GET',
        headers,
      },
      (res: IncomingMessage) => {
        let pending = '';
        res.on('data', (chunk: Buffer) => {
          pending += chunk.toString('utf-8');
          const lines = pending.split('\n');
          pending = lines.pop() ?? '';
          for (const line of lines) {
            if (onLine(line)) {
              res.destroy();
              return;
            }
          }
        });
        res.on('end', () => {
          if (pending.length > 0) onLine(pending);
          resolve();
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function run(): Promise<void> {
  // 1. POST /deploy
  const rawBody = JSON.stringify({ repo, release_id: releaseId });
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = signRequest(deployToken, ts, rawBody);

  core.info(`Triggering deploy for release ${releaseId} of ${repo}...`);

  const postRes = await makeRequest(`${deployUrl}/deploy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Deploy-Signature-256': signature,
      'X-Deploy-Timestamp': ts,
    },
    body: rawBody,
  });

  if (postRes.statusCode !== 202 && postRes.statusCode !== 200) {
    core.setFailed(`Deploy trigger failed: HTTP ${postRes.statusCode}`);
    return;
  }

  if (postRes.statusCode === 200) {
    core.info('Deploy already running — attaching to existing log stream...');
  } else {
    core.info('Deploy started (202). Streaming logs...');
  }

  // 2. Stream logs with reconnect
  let cursor = 0;
  let exitCode: number | null = null;
  const summaryLines: string[] = [];

  const RECONNECT_PAUSE_MS = 2_000;
  const MAX_RECONNECTS = 20;
  let reconnects = 0;

  while (exitCode === null && reconnects <= MAX_RECONNECTS) {
    try {
      await streamLines(
        `${deployUrl}/deploy/${releaseId}/logs?from=${cursor}`,
        {},
        (line: string) => {
          if (line === ':hb') return false; // heartbeat — skip

          if (line.startsWith('EXIT:')) {
            exitCode = parseInt(line.slice(5), 10);
            return true; // stop
          }

          core.info(line);
          summaryLines.push(line);
          cursor++;
          return false;
        },
      );
    } catch {
      // Connection dropped — reconnect
      reconnects++;
      core.warning(`Log stream disconnected — reconnecting (${reconnects}/${MAX_RECONNECTS})...`);
      await new Promise((r) => setTimeout(r, RECONNECT_PAUSE_MS));
    }

    if (exitCode !== null) break;
  }

  // 3. Write step summary
  await core.summary
    .addHeading(`Deploy ${repo} @ ${releaseId}`)
    .addCodeBlock(summaryLines.join('\n'), 'text')
    .write();

  if (exitCode === null) {
    core.setFailed('Log stream ended without EXIT marker');
  } else if (exitCode !== 0) {
    core.setFailed(`Deploy failed (EXIT:${exitCode})`);
  } else {
    core.info('Deploy succeeded.');
  }
}

run().catch((err: unknown) => {
  core.setFailed(String(err));
});

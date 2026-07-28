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
const releaseIdRaw = process.env['INPUT_RELEASE_ID'] ?? '';
const deployUrl = (process.env['INPUT_DEPLOY_URL'] || process.env['DEPLOY_URL'] || '').replace(/\/$/, '');
const deployToken = process.env['INPUT_HMAC_SECRET'] || process.env['DEPLOY_HMAC_SECRET'] || '';
// Resolve the deploy bundle asset name: explicit INPUT_BUNDLE override wins, else
// deploy-<type>.zip where type = deploy_type input || DEPLOY_TYPE_DEFAULT env || 'node'.
const deployType = process.env['INPUT_DEPLOY_TYPE'] || process.env['DEPLOY_TYPE_DEFAULT'] || 'node';
const bundle = process.env['INPUT_BUNDLE'] || `deploy-${deployType}.zip`;
const githubToken = process.env['GITHUB_TOKEN'] ?? '';

// GitHub Deployments tracking — opt-in via INPUT_ENVIRONMENT. When empty, all
// deployment tracking is skipped and deploy behaviour is unchanged.
const environment = process.env['INPUT_ENVIRONMENT'] ?? '';
const githubRepository = process.env['GITHUB_REPOSITORY'] ?? '';
const githubSha = process.env['GITHUB_SHA'] ?? '';

if (!repo || !releaseIdRaw || !deployUrl || !deployToken) {
  core.setFailed('Missing required inputs: repo, release_id, deploy_url, hmac_secret');
  process.exit(1);
}

/** Common headers for GitHub REST API calls. */
function ghHeaders(): Record<string, string> {
  return {
    ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'gitflow-deploy-action',
  };
}

/**
 * Resolve a release reference to its numeric ID and tag.
 *
 * Accepts either a numeric release ID or a tag string. The tag is used as the
 * GitHub Deployment ref; it may be null when a numeric ID cannot be looked up
 * (e.g. missing token) — callers fall back to GITHUB_SHA in that case.
 */
async function resolveRelease(raw: string): Promise<{ id: number; tag: string | null }> {
  const [owner, repoName] = repo.split('/');
  const asNum = parseInt(raw, 10);
  const isNumeric = !isNaN(asNum) && String(asNum) === raw.trim();

  if (isNumeric) {
    // Recover the tag for the deployment ref (best-effort).
    try {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repoName}/releases/${asNum}`,
        { headers: ghHeaders() },
      );
      if (res.ok) {
        const release = (await res.json()) as { tag_name?: string };
        return { id: asNum, tag: release.tag_name ?? null };
      }
    } catch {
      // ignore — fall back to no tag
    }
    return { id: asNum, tag: null };
  }

  core.info(`Resolving tag "${raw}" to release ID...`);
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/releases/tags/${encodeURIComponent(raw)}`,
    { headers: ghHeaders() },
  );
  if (!res.ok) throw new Error(`Failed to resolve tag "${raw}": ${res.status} ${await res.text()}`);
  const release = (await res.json()) as { id: number };
  core.info(`Resolved "${raw}" \u2192 release ID ${release.id}`);
  return { id: release.id, tag: raw };
}

/**
 * Open a GitHub Deployment against the target environment. Best-effort:
 * returns null (and never throws) when tracking is disabled or the API call
 * fails, so deploy behaviour is unchanged when the environment/token is absent.
 */
async function createDeployment(ref: string): Promise<number | null> {
  if (!environment || !githubRepository || !githubToken || !ref) return null;
  const [owner, repoName] = githubRepository.split('/');
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repoName}/deployments`, {
      method: 'POST',
      headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ref,
        environment,
        auto_merge: false,
        required_contexts: [],
        description: `Deploy ${repo} @ ${releaseIdRaw}`,
      }),
    });
    if (!res.ok) {
      core.warning(`Could not create GitHub Deployment: ${res.status} ${await res.text()}`);
      return null;
    }
    const dep = (await res.json()) as { id: number };
    core.info(`Opened GitHub Deployment ${dep.id} (${environment} @ ${ref})`);
    return dep.id;
  } catch (err) {
    core.warning(`Could not create GitHub Deployment: ${String(err)}`);
    return null;
  }
}

/** Set a GitHub Deployment status. Best-effort — warns but never throws. */
async function setDeploymentStatus(
  deploymentId: number,
  state: 'in_progress' | 'success' | 'failure',
): Promise<void> {
  if (!githubRepository || !githubToken) return;
  const [owner, repoName] = githubRepository.split('/');
  const serverUrl = process.env['GITHUB_SERVER_URL'] ?? 'https://github.com';
  const runId = process.env['GITHUB_RUN_ID'] ?? '';
  const logUrl = runId ? `${serverUrl}/${githubRepository}/actions/runs/${runId}` : undefined;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repoName}/deployments/${deploymentId}/statuses`,
      {
        method: 'POST',
        headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ state, environment, ...(logUrl ? { log_url: logUrl } : {}) }),
      },
    );
    if (!res.ok) {
      core.warning(`Could not set deployment status (${state}): ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    core.warning(`Could not set deployment status (${state}): ${String(err)}`);
  }
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
        if (res.statusCode !== 200) {
          res.resume(); // drain body
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
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
  const { id: releaseId, tag } = await resolveRelease(releaseIdRaw);

  // Open a GitHub Deployment (best-effort; skipped when no environment/token).
  const deployRef = tag ?? githubSha;
  const deploymentId = await createDeployment(deployRef);
  if (deploymentId !== null) await setDeploymentStatus(deploymentId, 'in_progress');

  // 1. POST /deploy
  const rawBody = JSON.stringify({ repo, release_id: releaseId, bundle });
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
    if (deploymentId !== null) await setDeploymentStatus(deploymentId, 'failure');
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
    if (deploymentId !== null) await setDeploymentStatus(deploymentId, 'failure');
    core.setFailed('Log stream ended without EXIT marker');
  } else if (exitCode !== 0) {
    if (deploymentId !== null) await setDeploymentStatus(deploymentId, 'failure');
    core.setFailed(`Deploy failed (EXIT:${exitCode})`);
  } else {
    // 4. Health check — confirm service came back up after any restart
    core.info('Waiting for service health check...');
    const HEALTH_TIMEOUT_MS = 30_000;
    const HEALTH_POLL_MS = 2_000;
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    let healthy = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
      try {
        const healthRes = await makeRequest(`${deployUrl}/health`, { method: 'GET', headers: {} });
        if (healthRes.statusCode === 200) {
          healthy = true;
          break;
        }
      } catch {
        // service not up yet — keep polling
      }
    }
    if (healthy) {
      if (deploymentId !== null) await setDeploymentStatus(deploymentId, 'success');
      core.info('Service is healthy ✓');
    } else {
      if (deploymentId !== null) await setDeploymentStatus(deploymentId, 'failure');
      core.setFailed(`Service did not return healthy within ${HEALTH_TIMEOUT_MS / 1000}s after deploy`);
    }
  }
}

run().catch((err: unknown) => {
  core.setFailed(String(err));
});

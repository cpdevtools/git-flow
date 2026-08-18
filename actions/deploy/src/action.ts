import * as core from '@actions/core';
import { createHmac } from 'node:crypto';
import { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { URL } from 'node:url';

/** Strip ANSI escape/color codes so the step summary renders cleanly. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g, '');
}

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

/**
 * Parse KEY=VAL lines into a plain object. Empty lines and lines without '='
 * are silently skipped so indented YAML blocks and trailing newlines are safe.
 */
function parseEnvLines(raw: string): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  let any = false;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes('=')) continue;
    const eq = trimmed.indexOf('=');
    result[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    any = true;
  }
  return any ? result : undefined;
}

const deployEnv = parseEnvLines(process.env['INPUT_DEPLOY_ENV'] ?? '');

// Comma-separated allowlist of deploy methods for this environment.
// Set via DEPLOY_ALLOWED_METHODS GitHub Environment variable, surfaced through
// the workflow's env: block. NOT a workflow_dispatch input — that would let
// callers bypass the restriction.
const allowedMethods = (process.env['INPUT_ALLOWED_METHODS'] ?? '')
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);

const missingInputs = Object.entries({
  repo,
  release_id: releaseIdRaw,
  deploy_url: deployUrl,
  hmac_secret: deployToken,
})
  .filter(([, value]) => !value)
  .map(([name]) => name);
if (missingInputs.length > 0) {
  // Name only what is actually missing: an empty hmac_secret usually means the
  // GitHub Environment lacks the secret the workflow references, and listing
  // all four inputs sent that diagnosis in the wrong direction.
  core.setFailed(`Missing required inputs: ${missingInputs.join(', ')}`);
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
async function resolveRelease(raw: string): Promise<{ id: number; tag: string | null; htmlUrl: string | null }> {
  const [owner, repoName] = repo.split('/');
  const asNum = parseInt(raw, 10);
  const isNumeric = !isNaN(asNum) && String(asNum) === raw.trim();

  if (isNumeric) {
    // Recover the tag + html url for the deployment ref / summary link (best-effort).
    try {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repoName}/releases/${asNum}`,
        { headers: ghHeaders() },
      );
      if (res.ok) {
        const release = (await res.json()) as { tag_name?: string; html_url?: string };
        return { id: asNum, tag: release.tag_name ?? null, htmlUrl: release.html_url ?? null };
      }
    } catch {
      // ignore — fall back to no tag
    }
    return { id: asNum, tag: null, htmlUrl: null };
  }

  core.info(`Resolving tag "${raw}" to release ID...`);
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/releases/tags/${encodeURIComponent(raw)}`,
    { headers: ghHeaders() },
  );
  if (!res.ok) throw new Error(`Failed to resolve tag "${raw}": ${res.status} ${await res.text()}`);
  const release = (await res.json()) as { id: number; html_url?: string };
  core.info(`Resolved "${raw}" \u2192 release ID ${release.id}`);
  return { id: release.id, tag: raw, htmlUrl: release.html_url ?? null };
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
              // Resolve BEFORE destroying: a destroyed client response settles
              // neither handler on every Node version, and an unsettled promise
              // here lets the event loop drain — the process then exits 0 with
              // the verdict code below never run, reporting SUCCESS for a
              // deploy whose stream said EXIT:1 (observed in production).
              resolve();
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

/**
 * Cross-checks a streamed EXIT:0 against the gateway's own deploy record.
 *
 * The deploy log is a shared append-only file, so two writers racing (a replica
 * crash-marking a record it believes abandoned vs. the live owner finishing) can
 * interleave EXIT lines, and the first one the stream delivers is not necessarily
 * the verdict. GET /deploy/{id} reports the record's settled status; only
 * 'completed' confirms the success the stream claimed.
 *
 * Returns true on confirmation — and also, with a loud warning, when the record
 * cannot be read at all: the gateway may be mid-restart from a self-update, and a
 * status blip must not fail a deploy two independent signals (EXIT:0 and the
 * /status health check that follows) call good.
 */
async function recordConfirmsSuccess(releaseId: number): Promise<boolean> {
  const CONFIRM_TIMEOUT_MS = 20_000;
  const CONFIRM_POLL_MS = 2_000;
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  let lastProblem = 'record not read yet';

  while (Date.now() < deadline) {
    try {
      const res = await makeRequest(`${deployUrl}/deploy/${releaseId}`, { method: 'GET', headers: {} });
      if (res.statusCode === 200) {
        const status = (JSON.parse(res.body) as { status?: string }).status;
        if (status === 'completed') return true;
        if (status === 'failed') {
          core.error(`Gateway deploy record for release ${releaseId} reports status 'failed'.`);
          return false;
        }
        lastProblem = `record still '${status ?? 'unknown'}'`; // settling — keep polling
      } else {
        lastProblem = `HTTP ${res.statusCode}`;
      }
    } catch (err) {
      lastProblem = String(err);
    }
    await new Promise((r) => setTimeout(r, CONFIRM_POLL_MS));
  }

  core.warning(
    `Could not confirm the deploy record for release ${releaseId} within ${CONFIRM_TIMEOUT_MS / 1000}s ` +
      `(${lastProblem}); trusting the streamed EXIT:0 and the health check.`,
  );
  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function run(): Promise<void> {
  const { id: releaseId, tag, htmlUrl } = await resolveRelease(releaseIdRaw);
  const releaseUrl =
    htmlUrl ?? (tag ? `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}` : null);

  // Open a GitHub Deployment (best-effort; skipped when no environment/token).
  const deployRef = tag ?? githubSha;
  const deploymentId = await createDeployment(deployRef);
  if (deploymentId !== null) await setDeploymentStatus(deploymentId, 'in_progress');

  // Enforce environment-level method allowlist before touching the gateway.
  if (allowedMethods.length > 0 && !allowedMethods.includes(deployType)) {
    if (deploymentId !== null) await setDeploymentStatus(deploymentId, 'failure');
    core.setFailed(
      `Deploy method '${deployType}' is not allowed in this environment. ` +
        `Allowed: ${allowedMethods.join(', ')}`,
    );
    return;
  }

  // 1. POST /deploy
  const rawBody = JSON.stringify({ repo, release_id: releaseId, bundle, ...(deployEnv ? { env: deployEnv } : {}) });
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
  // The gateway prefixes every fatal deploy step with '▸ Error:' immediately
  // before finishing the record. Track it so a buggy/older gateway that streams
  // a fatal error but then reports EXIT:0 cannot make us report success.
  let sawFatalError = false;
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
            // Print it: when a verdict is ever disputed (a crash-marked record racing a
            // live owner's finish), the job log must show WHICH exit line the action
            // acted on, not leave it to be inferred.
            core.info(line);
            summaryLines.push(line);
            exitCode = parseInt(line.slice(5), 10);
            return true; // stop
          }

          if (line.startsWith('▸ Error:')) sawFatalError = true;

          core.info(line);
          summaryLines.push(line);
          cursor++;
          return false;
        },
      );
      // streamLines resolved without an EXIT marker: the gateway closed the
      // connection before the deploy finished. Count it as a reconnect (with a
      // pause) so we don't tight-loop, and so we eventually fail via the
      // 'ended without EXIT marker' path instead of spinning forever.
      if (exitCode === null) {
        reconnects++;
        await new Promise((r) => setTimeout(r, RECONNECT_PAUSE_MS));
      }
    } catch {
      // Connection dropped — reconnect
      reconnects++;
      core.warning(`Log stream disconnected — reconnecting (${reconnects}/${MAX_RECONNECTS})...`);
      await new Promise((r) => setTimeout(r, RECONNECT_PAUSE_MS));
    }

    if (exitCode !== null) break;
  }

  // 3. Write step summary
  const releaseRef = releaseUrl ? `[${tag ?? releaseId}](${releaseUrl})` : String(tag ?? releaseId);
  await core.summary
    .addHeading(`Deploy ${repo} @ ${releaseId}`)
    .addRaw(`\n**Release:** ${releaseRef}\n`, true)
    .addCodeBlock(stripAnsi(summaryLines.join('\n')), 'text')
    .write();

  if (exitCode === null) {
    if (deploymentId !== null) await setDeploymentStatus(deploymentId, 'failure');
    core.setFailed('Log stream ended without EXIT marker');
  } else if (exitCode !== 0) {
    if (deploymentId !== null) await setDeploymentStatus(deploymentId, 'failure');
    core.setFailed(`Deploy failed (EXIT:${exitCode})`);
  } else if (sawFatalError) {
    // The gateway streamed a fatal '▸ Error:' line but still reported EXIT:0
    // (e.g. an older gateway build). Never treat that as a successful deploy.
    if (deploymentId !== null) await setDeploymentStatus(deploymentId, 'failure');
    core.setFailed('Deploy reported success but a fatal error was logged');
  } else if (!(await recordConfirmsSuccess(releaseId))) {
    // The stream said EXIT:0 but the gateway's own record disagrees. The log is
    // shared between replicas, so a takeover racing the real owner can interleave
    // two EXIT lines and the first one to stream is not necessarily the verdict.
    if (deploymentId !== null) await setDeploymentStatus(deploymentId, 'failure');
    core.setFailed("Stream reported EXIT:0 but the gateway's deploy record says the deploy failed");
  } else {
    // 4. Status check — confirm service came back up after any restart
    core.info('Waiting for service status check...');
    const HEALTH_TIMEOUT_MS = 30_000;
    const HEALTH_POLL_MS = 2_000;
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    let healthy = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
      try {
        const healthRes = await makeRequest(`${deployUrl}/status`, { method: 'GET', headers: {} });
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

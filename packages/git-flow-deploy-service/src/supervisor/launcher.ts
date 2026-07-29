import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
/**
 * Deploy methods under which this service runs inside a container that its own
 * deploy command replaces.
 */
export const CONTAINERIZED_METHODS = new Set(['compose', 'swarm']);

/**
 * Env vars that describe THIS container's runtime rather than the deployment.
 * They must not be forwarded to a supervisor container, whose image has its own
 * interpreter paths and would break if we overwrote them.
 */
const SUPERVISOR_ENV_BLOCKLIST = new Set([
  'PATH',
  'HOME',
  'HOSTNAME',
  'PWD',
  'OLDPWD',
  'SHLVL',
  '_',
  'NODE_VERSION',
  'YARN_VERSION',
]);

/**
 * Where a supervisor has to run to survive the deploy it drives.
 *
 * - `bare`        — a detached `setsid` session on the host. Escapes pm2's
 *                   process tree and can drive npm/pm2 *and* docker.
 * - `container`   — a sibling container. The only thing that survives
 *                   `compose down` / `up --force-recreate` of our own container.
 * - `unsupported` — leaving a containerized mode for a host one. The supervisor
 *                   would have to install and start a process on the Docker
 *                   host, which nothing inside a container can do.
 */
export type SupervisorPlacement = 'bare' | 'container' | 'unsupported';

/** Decide where the supervisor for a `from` → `to` transition must run. */
export function supervisorPlacement(
  from: string | undefined,
  to: string | undefined,
): SupervisorPlacement {
  if (!CONTAINERIZED_METHODS.has(from ?? '')) return 'bare';
  return CONTAINERIZED_METHODS.has(to ?? '') ? 'container' : 'unsupported';
}

/** The container this service currently runs in. */
export interface ContainerTarget {
  id: string;
  image: string;
}

export interface LaunchResult {
  ok: boolean;
  error?: string;
}

/**
 * Candidate locations of the deploy-service CLI, most authoritative first.
 *
 * The CLI ships beside the service entrypoint in every packaging we produce —
 * `dist/main.js` + `dist/cli.cjs` — whether that `dist` is `/app/dist` in the
 * image or the npm global prefix, and a supervisor container runs our own image,
 * so the same path resolves there too.
 *
 * Anchored on `__dirname` (this module lives at `<dist>/supervisor/launcher.js`)
 * rather than `process.argv[1]`. argv[1] is NOT ours under pm2: in cluster mode
 * the child is launched through pm2's own `ProcessContainer.js`, which resolved
 * to `<nvm>/lib/node_modules/pm2/lib/cli.cjs` on a real deploy host and refused
 * every node → containerized mode change. It also would have been a *relative*
 * path in the image (`CMD ["node", "dist/main"]`), which means nothing to a
 * supervisor container started with `--workdir <bundleDir>`.
 */
function supervisorCliCandidates(): string[] {
  return [
    // Normal nest build: <dist>/supervisor/launcher.js → <dist>/cli.cjs
    resolve(__dirname, '..', 'cli.cjs'),
    // If this module is ever bundled directly into <dist>/.
    resolve(__dirname, 'cli.cjs'),
    // Last resort for packagings we haven't anticipated.
    resolve(dirname(process.argv[1] ?? ''), 'cli.cjs'),
  ];
}

/** Absolute path of the deploy-service CLI. */
export function resolveSupervisorCli(): string {
  const explicit = process.env['DEPLOY_SUPERVISOR_CLI'];
  if (explicit) return explicit;
  const candidates = supervisorCliCandidates();
  return candidates.find((c) => existsSync(c)) ?? candidates[0];
}

/**
 * Fail fast when the CLI is missing. A supervisor that cannot start writes
 * nothing to deploy.log, so the deploy would hang until the tail times out
 * instead of reporting the real problem.
 */
function checkCli(): LaunchResult | undefined {
  const cli = resolveSupervisorCli();
  if (existsSync(cli)) return undefined;
  const tried = process.env['DEPLOY_SUPERVISOR_CLI']
    ? [cli]
    : supervisorCliCandidates();
  return {
    ok: false,
    error:
      `supervisor CLI not found (tried ${tried.join(', ')}) — ` +
      'set DEPLOY_SUPERVISOR_CLI to its absolute path',
  };
}

/**
 * Launch the supervisor in a new session on this host. Survives the teardown of
 * the current process (pm2 stop/restart) because it is no longer in its tree.
 */
export function launchBare(planPath: string, cwd: string): LaunchResult {
  const missing = checkCli();
  if (missing) return missing;
  try {
    const child = spawn(
      'setsid',
      [
        process.execPath,
        resolveSupervisorCli(),
        'supervise',
        '--plan',
        planPath,
      ],
      { cwd, env: process.env, detached: true, stdio: 'ignore' },
    );
    child.unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Launch the supervisor in a sibling container.
 *
 * It inherits our bind mounts via `--volumes-from`, so the bundle dir, state dir
 * and Docker socket appear at exactly the paths already baked into the plan — no
 * host-path translation needed (the host paths behind our mounts are not
 * knowable from in here, and the mounts outlive the removal of the container
 * they came from). It runs OUR image, which is guaranteed to be present locally
 * and already ships node plus the docker CLI and compose plugin, so the handoff
 * never depends on pulling a helper image.
 */
export function launchContainer(
  planPath: string,
  cwd: string,
  target: ContainerTarget,
): LaunchResult {
  // Same image, so our own filesystem is a valid probe for the supervisor's.
  const missing = checkCli();
  if (missing) return missing;

  const args = [
    'run',
    '--detach',
    '--rm',
    '--volumes-from',
    target.id,
    '--workdir',
    cwd,
  ];

  // Forward our deployment env (COMPOSE_FILE, DEPLOY_*, GITHUB_TOKEN, …) so the
  // bundle's ${VAR} interpolation resolves exactly as it would have in here.
  // Args are passed as an array, never through a shell, so values need no quoting.
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || SUPERVISOR_ENV_BLOCKLIST.has(key)) continue;
    args.push('--env', `${key}=${value}`);
  }

  args.push(
    '--entrypoint',
    'node',
    target.image,
    resolveSupervisorCli(),
    'supervise',
    '--plan',
    planPath,
  );

  const res = spawnSync('docker', args, { encoding: 'utf-8' });
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || '').trim();
    return {
      ok: false,
      error: detail || `docker run exited with ${res.status}`,
    };
  }
  return { ok: true };
}

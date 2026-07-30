/**
 * The contract between the deploy controller and the supervisor process.
 *
 * A self-replacing deploy cannot be run by the process it replaces, so the
 * controller writes a plan next to the bundle and hands it to
 * `gitflow-deploy-service supervise --plan <file>` running somewhere that
 * survives the swap (see `./launcher.ts`).
 *
 * Using a JSON file instead of argv/env keeps every value free of shell quoting
 * and leaves a readable artifact beside the bundle it deployed.
 */

/** A single shell command run by the supervisor. */
export interface SupervisorStep {
  /** Directory the command runs in. */
  cwd: string;
  /** Shell command line (executed with `shell: true`). */
  command: string;
}

/** Paths committed atomically once the deploy step succeeds. */
export interface SupervisorCommit {
  /** `<stateDir>/<slot>/current` — the retained copy of the running bundle. */
  currentDir: string;
  /** Freshly extracted bundle that becomes `currentDir`. */
  newBundle: string;
  /** `<stateDir>/<slot>/state.json`. */
  stateFile: string;
  /** Staged `state.new.json`, moved onto `stateFile` on success. */
  stateNewFile: string;
}

/**
 * COMPATIBILITY: a supervisor running in a sibling container runs the OUTGOING
 * image — i.e. the PREVIOUS release's `supervise` implementation. Fields may
 * only be added, and additions must be optional.
 */
export interface SupervisorPlan {
  /** Absolute path of the deploy.log to append to (the log-reconnect seam). */
  log: string;
  /** Deployment slot being changed. */
  slot: string;
  /** Version being deployed. */
  version: string;
  /** Banner line written when the supervisor starts. */
  label: string;
  /** Grace period before starting, so the triggering HTTP response can flush. */
  delayMs: number;
  /** Tears the outgoing mode down. Absent for a same-mode redeploy. */
  teardown?: SupervisorStep;
  /** Brings the new release/mode up. */
  deploy: SupervisorStep;
  /** Restores the outgoing deployment when `deploy` fails. */
  rollback?: SupervisorStep;
  /** State to commit once `deploy` succeeds. */
  commit: SupervisorCommit;
  /** Extra environment variables merged into every step (teardown, deploy, rollback). */
  env?: Record<string, string>;
}

/** File name the plan is written under, inside the release work dir. */
export const SUPERVISOR_PLAN_FILE = 'supervisor-plan.json';

/** Grace period before the supervisor touches anything, in milliseconds. */
export const SUPERVISOR_DELAY_MS = 3_000;

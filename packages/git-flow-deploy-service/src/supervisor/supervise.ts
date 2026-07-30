import { runDeploy } from '@cpdevtools/git-flow-deploy';
import {
  appendFileSync,
  cpSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import type { SupervisorPlan, SupervisorStep } from './plan.js';

/**
 * Execute a supervisor plan.
 *
 * Runs as its own process — either a detached `setsid` session on the host or a
 * sibling container — so it outlives the teardown/replacement of the service
 * that scheduled it. Everything it emits is appended to the release's
 * `deploy.log`, terminated by `EXIT:<code>`; the surviving or restarted service
 * tails that file to finalize the deploy record, and the GitHub Action streams
 * it through to the workflow log.
 *
 * Never throws: a supervisor that dies without writing EXIT leaves the deploy
 * record hanging until the tail times out.
 */
export async function runSupervisor(planPath: string): Promise<number> {
  let plan: SupervisorPlan;
  try {
    plan = JSON.parse(readFileSync(planPath, 'utf-8')) as SupervisorPlan;
  } catch (err) {
    // No plan means no log path either — the parent finalizes on tail timeout.
    console.error(
      `supervise: cannot read plan ${planPath}: ${(err as Error).message}`,
    );
    return 1;
  }

  const log = (line: string): void => {
    try {
      appendFileSync(plan.log, `${line}\n`);
    } catch {
      // Best effort: losing a log line must not abort the deploy.
    }
  };
  const run = (step: SupervisorStep): Promise<number> =>
    runDeploy({ deployCommand: step.command }, step.cwd, log, plan.env).catch(
      (err: Error) => {
        log(`▸ Error: ${err.message}`);
        return 1;
      },
    );

  // Like run(), but suppresses EXIT: lines so a nested supervisor script (e.g.
  // restart.sh invoked during rollback) cannot write EXIT:0 and mislead the
  // action into reporting success before this supervisor appends EXIT:1.
  const runFiltered = (step: SupervisorStep): Promise<number> =>
    runDeploy(
      { deployCommand: step.command },
      step.cwd,
      (line) => { if (!line.startsWith('EXIT:')) log(line); },
      plan.env,
    ).catch((err: Error) => {
      log(`▸ Error: ${err.message}`);
      return 1;
    });

  // The request that triggered this deploy is still being answered by the
  // process we are about to replace; let it flush and persist its record.
  if (plan.delayMs > 0) await new Promise((r) => setTimeout(r, plan.delayMs));

  log(`=== ${plan.label} — ${new Date().toISOString()} ===`);

  if (plan.teardown) {
    log(`▸ Tearing down the previous deployment: ${plan.teardown.command}`);
    // A failed teardown is not fatal — the new mode may still come up, and the
    // rollback path below is the safety net if it does not.
    const code = await run(plan.teardown);
    if (code !== 0) log(`▸ Warning: teardown exited ${code}; continuing.`);
  }

  log(`▸ Running: ${plan.deploy.command}`);
  const code = await run(plan.deploy);

  if (code === 0) {
    commit(plan, log);
    log(`✓ ${plan.slot} is running v${plan.version}.`);
    log('EXIT:0');
    return 0;
  }

  log(`✗ Deploy of v${plan.version} failed (exit ${code}).`);
  rmSync(plan.commit.stateNewFile, { force: true });

  // Write EXIT:1 BEFORE starting rollback. The rollback may restart the service
  // (pm2 restart), and the new instance will read this log on boot. If EXIT:1 is
  // already here, restoreRecord finds it and marks the deploy failed — even if
  // the version numbers match (same version, different mode). Without this, the
  // boot-restore logic races ahead and declares success.
  log('EXIT:1');

  if (plan.rollback && existsSync(plan.rollback.cwd)) {
    log(`▸ Rolling back: ${plan.rollback.command}`);
    const rollbackCode = await runFiltered(plan.rollback);
    log(
      rollbackCode === 0
        ? '▸ Rolled back to the previous deployment.'
        : `▸ Rollback FAILED (exit ${rollbackCode}); manual intervention required.`,
    );
  }

  return 1;
}

/**
 * Promote the new bundle and its staged state. The bundle is copied to a temp
 * sibling and swapped in, so a crash mid-copy never corrupts the retained one.
 */
function commit(plan: SupervisorPlan, log: (line: string) => void): void {
  const { currentDir, newBundle, stateFile, stateNewFile } = plan.commit;
  const staging = `${currentDir}.tmp`;
  try {
    rmSync(staging, { recursive: true, force: true });
    cpSync(newBundle, staging, { recursive: true });
    rmSync(currentDir, { recursive: true, force: true });
    renameSync(staging, currentDir);
    renameSync(stateNewFile, stateFile);
  } catch (err) {
    log(
      `▸ Warning: failed to commit deployment state: ${(err as Error).message}`,
    );
  }
}

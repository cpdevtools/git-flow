import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

jest.mock('@cpdevtools/git-flow-deploy', () => {
  const actual = jest.requireActual('@cpdevtools/git-flow-deploy');
  return { __esModule: true, ...actual, runDeploy: jest.fn() };
});

import { runDeploy } from '@cpdevtools/git-flow-deploy';
import { runSupervisor } from './supervise.js';
import type { SupervisorPlan } from './plan.js';

const runMock = runDeploy as jest.Mock;

describe('runSupervisor', () => {
  let root: string;
  let planPath: string;
  let exitCodes: Record<string, number>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gfsup-'));
    planPath = join(root, 'plan.json');
    exitCodes = {};
    runMock.mockImplementation(
      (
        m: { deployCommand: string },
        _cwd: string,
        onLine: (l: string) => void,
      ) => {
        onLine(`out: ${m.deployCommand}`);
        return Promise.resolve(exitCodes[m.deployCommand] ?? 0);
      },
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  /** Build a plan over a realistic on-disk layout and write it to planPath. */
  function writePlan(overrides: Partial<SupervisorPlan> = {}): SupervisorPlan {
    const newBundle = join(root, 'work', '123');
    const priorBundle = join(root, 'state', 'slot-a', 'current');
    mkdirSync(newBundle, { recursive: true });
    mkdirSync(priorBundle, { recursive: true });
    writeFileSync(join(newBundle, 'deploy.yml'), 'new');
    writeFileSync(join(priorBundle, 'deploy.yml'), 'old');

    const stateNewFile = join(root, 'state', 'slot-a', 'state.new.json');
    writeFileSync(
      stateNewFile,
      JSON.stringify({ method: 'compose', version: '2.0.0' }),
    );

    const plan: SupervisorPlan = {
      log: join(newBundle, 'deploy.log'),
      slot: 'slot-a',
      version: '2.0.0',
      label: 'self redeploy → v2.0.0',
      delayMs: 0,
      deploy: { cwd: newBundle, command: 'deploy-new' },
      rollback: { cwd: priorBundle, command: 'deploy-old' },
      commit: {
        currentDir: priorBundle,
        newBundle,
        stateFile: join(root, 'state', 'slot-a', 'state.json'),
        stateNewFile,
      },
      ...overrides,
    };
    writeFileSync(planPath, JSON.stringify(plan));
    return plan;
  }

  const logLines = (plan: SupervisorPlan): string[] =>
    readFileSync(plan.log, 'utf-8').split('\n').filter(Boolean);

  const commands = (): string[] =>
    runMock.mock.calls.map(
      (c) => (c[0] as { deployCommand: string }).deployCommand,
    );

  it('runs the deploy, commits the bundle and state, and terminates the log with EXIT:0', async () => {
    const plan = writePlan();

    await expect(runSupervisor(planPath)).resolves.toBe(0);

    expect(commands()).toEqual(['deploy-new']);
    // The bundle is promoted into current/ and the staged state committed.
    expect(
      readFileSync(join(plan.commit.currentDir, 'deploy.yml'), 'utf-8'),
    ).toBe('new');
    expect(existsSync(plan.commit.stateNewFile)).toBe(false);
    const committed = JSON.parse(
      readFileSync(plan.commit.stateFile, 'utf-8'),
    ) as { version: string };
    expect(committed.version).toBe('2.0.0');

    const lines = logLines(plan);
    expect(lines[0]).toContain('self redeploy → v2.0.0');
    expect(lines).toContain('out: deploy-new'); // command output is streamed into deploy.log
    expect(lines[lines.length - 1]).toBe('EXIT:0'); // the seam the service tails for
  });
  it('runs teardown before the deploy when the plan has one', async () => {
    const plan = writePlan({
      label: 'self mode-change node → compose',
      teardown: { cwd: root, command: 'teardown-old' },
    });

    await expect(runSupervisor(planPath)).resolves.toBe(0);

    expect(commands()).toEqual(['teardown-old', 'deploy-new']);
    expect(logLines(plan)[0]).toContain('node → compose');
  });

  it('rolls back, discards the staged state, and terminates with EXIT:1 when the deploy fails', async () => {
    const plan = writePlan({
      teardown: { cwd: root, command: 'teardown-old' },
    });
    exitCodes['deploy-new'] = 1;

    await expect(runSupervisor(planPath)).resolves.toBe(1);

    expect(commands()).toEqual(['teardown-old', 'deploy-new', 'deploy-old']);
    expect(existsSync(plan.commit.stateNewFile)).toBe(false); // never committed
    expect(existsSync(plan.commit.stateFile)).toBe(false); // prior state untouched
    expect(
      readFileSync(join(plan.commit.currentDir, 'deploy.yml'), 'utf-8'),
    ).toBe('old');

    const lines = logLines(plan);
    expect(lines.some((l) => l.includes('Rolled back'))).toBe(true);
    expect(lines[lines.length - 1]).toBe('EXIT:1');
  });

  it('continues to the deploy when teardown fails — rollback is the safety net', async () => {
    const plan = writePlan({
      teardown: { cwd: root, command: 'teardown-old' },
    });
    exitCodes['teardown-old'] = 1;

    await expect(runSupervisor(planPath)).resolves.toBe(0);

    expect(commands()).toEqual(['teardown-old', 'deploy-new']);
    expect(logLines(plan).some((l) => l.includes('teardown exited 1'))).toBe(
      true,
    );
  });

  it('treats a deploy that throws as a failure rather than dying without EXIT', async () => {
    const plan = writePlan({ rollback: undefined });
    runMock.mockRejectedValueOnce(new Error('spawn ENOENT'));

    await expect(runSupervisor(planPath)).resolves.toBe(1);

    const lines = logLines(plan);
    expect(lines.some((l) => l.includes('spawn ENOENT'))).toBe(true);
    expect(lines[lines.length - 1]).toBe('EXIT:1');
  });

  it('does not roll back into a bundle dir that no longer exists', async () => {
    const plan = writePlan();
    rmSync(plan.rollback!.cwd, { recursive: true, force: true });
    exitCodes['deploy-new'] = 1;

    await expect(runSupervisor(planPath)).resolves.toBe(1);

    expect(commands()).toEqual(['deploy-new']);
    expect(logLines(plan)[logLines(plan).length - 1]).toBe('EXIT:1');
  });

  it('fails without throwing when the plan file is unreadable', async () => {
    await expect(runSupervisor(join(root, 'missing.json'))).resolves.toBe(1);
    expect(runMock).not.toHaveBeenCalled();
  });
});

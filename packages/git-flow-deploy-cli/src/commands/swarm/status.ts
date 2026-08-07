import { Command, Args, Flags } from '@oclif/core';
import { stackRollout } from '@cpdevtools/git-flow-deploy';

/**
 * Answer "did the rolling update converge?" — the question `docker stack deploy`
 * cannot answer, because it returns as soon as the manager accepts the new spec.
 *
 * Exit code is the answer: 0 = converged, 1 = rolled back or paused (the update
 * failed), 2 = still rolling or undeterminable. A caller waiting on a self-update
 * keeps waiting on 2 and only acts on 0 or 1.
 */
export default class SwarmStatus extends Command {
  static override description = 'Report whether a swarm stack\u2019s rolling update has converged';

  static override examples = [
    '<%= config.bin %> swarm status idealsupply-deploy-gateway',
    '<%= config.bin %> swarm status idealsupply-deploy-gateway --quiet',
  ];

  static override args = {
    stack: Args.string({ description: 'Swarm stack name', required: true }),
  };

  static override flags = {
    quiet: Flags.boolean({
      char: 'q',
      description: 'Suppress output and report the result only through the exit code',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SwarmStatus);
    const rollout = stackRollout(args['stack']);

    if (!flags['quiet']) {
      for (const s of rollout.services) {
        this.log(`${s.service}: ${s.state}${s.message ? ` — ${s.message}` : ''}`);
      }
      if (rollout.error) this.log(`unknown: ${rollout.error}`);
      this.log(`${args['stack']}: ${rollout.state}`);
    }

    if (rollout.state === 'converged') this.exit(0);
    if (rollout.state === 'rolled-back') this.exit(1);
    this.exit(2);
  }
}

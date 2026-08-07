import { Command, Args, Flags } from '@oclif/core';
import { readReposConfig, isRepoAllowed } from '@cpdevtools/git-flow-deploy';

/**
 * Exit code is the answer, so callers in other languages can use it directly:
 * 0 = allowed, 1 = denied, 2 = could not decide. Anything non-zero must be
 * treated as "not allowed" by the caller.
 */
export default class ReposCheck extends Command {
  static override description = 'Check whether a repo is permitted by the allow/deny rules';

  static override examples = [
    '<%= config.bin %> repos check cpdevtools/git-flow',
    '<%= config.bin %> repos check cpdevtools/git-flow --quiet',
  ];

  static override args = {
    repo: Args.string({ description: 'GitHub repo (owner/repo)', required: true }),
  };

  static override flags = {
    quiet: Flags.boolean({
      char: 'q',
      description: 'Suppress output and report the result only through the exit code',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ReposCheck);
    const repo = args['repo'];

    let allowed: boolean;
    try {
      allowed = isRepoAllowed(repo, await readReposConfig());
    } catch (err) {
      this.error(`Cannot evaluate repo rules: ${(err as Error).message}`, { exit: 2 });
    }

    if (!flags['quiet']) this.log(allowed ? `allowed: ${repo}` : `denied: ${repo}`);
    this.exit(allowed ? 0 : 1);
  }
}

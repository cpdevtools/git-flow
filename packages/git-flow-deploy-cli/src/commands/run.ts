import { Command, Flags } from '@oclif/core';
import { join } from 'node:path';
import { parseDeployYml, runDeploy } from '@cpdevtools/git-flow-deploy';

export default class Run extends Command {
  static override description =
    'Execute deployCommand from an already-extracted deploy bundle. Streams stdout/stderr. Exits 0/1.';

  static override examples = [
    '<%= config.bin %> run --work-dir /tmp/deploy-gateway/123456789',
  ];

  static override flags = {
    'work-dir': Flags.string({
      char: 'w',
      description: 'Directory containing the extracted deploy bundle',
      required: false,
      default: process.cwd(),
    }),
    manifest: Flags.string({
      char: 'm',
      description: 'Path to deploy.yml (defaults to <work-dir>/deploy.yml)',
      required: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Run);
    const workDir = flags['work-dir'];
    const manifestPath = flags['manifest'] ?? join(workDir, 'deploy.yml');

    const manifest = await parseDeployYml(manifestPath);

    this.log(`Running: ${manifest.deployCommand}`);

    const exitCode = await runDeploy(manifest, workDir, (line) => {
      process.stdout.write(line + '\n');
    });

    this.exit(exitCode);
  }
}

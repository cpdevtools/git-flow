import { Command, Flags } from '@oclif/core';
import { signRequest } from '@cpdevtools/git-flow-deploy';
import { readSecret, readStdin } from '../../secrets.js';

export default class HmacSign extends Command {
  static override description =
    'Sign a request body read from stdin; prints the X-Deploy-Signature-256 value';

  static override examples = [
    'echo -n \'{"repo":"owner/repo"}\' | <%= config.bin %> hmac sign --timestamp 1700000000',
  ];

  static override flags = {
    timestamp: Flags.string({
      char: 't',
      description: 'Unix-seconds timestamp (defaults to now)',
      required: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(HmacSign);
    const ts = flags['timestamp'] ?? String(Math.floor(Date.now() / 1000));

    let secret: string;
    try {
      secret = await readSecret('DEPLOY_HMAC_SECRET');
    } catch (err) {
      this.error((err as Error).message, { exit: 2 });
    }

    this.log(signRequest(secret, ts, await readStdin()));
  }
}

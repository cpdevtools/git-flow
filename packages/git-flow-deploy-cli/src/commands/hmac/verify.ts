import { Command, Flags } from '@oclif/core';
import {
  validateHmac,
  validateTimestamp,
  DEFAULT_TIMESTAMP_WINDOW_SECONDS,
} from '@cpdevtools/git-flow-deploy';
import { readSecret, readStdin } from '../../secrets.js';

/**
 * Exit code is the answer, so callers in other languages can use it directly:
 * 0 = valid, 1 = rejected, 2 = could not decide. Anything non-zero must be
 * treated as "not authenticated" by the caller.
 */
export default class HmacVerify extends Command {
  static override description =
    'Verify an X-Deploy-Signature-256 and timestamp against a body read from stdin';

  static override examples = [
    'cat body.json | <%= config.bin %> hmac verify --signature "sha256=..." --timestamp 1700000000',
  ];

  static override flags = {
    signature: Flags.string({
      char: 's',
      description: 'X-Deploy-Signature-256 header value',
      required: true,
    }),
    timestamp: Flags.string({
      char: 't',
      description: 'X-Deploy-Timestamp header value',
      required: true,
    }),
    window: Flags.integer({
      char: 'w',
      description: 'Permitted timestamp skew in seconds',
      default: DEFAULT_TIMESTAMP_WINDOW_SECONDS,
    }),
    quiet: Flags.boolean({
      char: 'q',
      description: 'Suppress output and report the result only through the exit code',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(HmacVerify);

    let secret: string;
    try {
      secret = await readSecret('DEPLOY_HMAC_SECRET');
    } catch (err) {
      this.error((err as Error).message, { exit: 2 });
    }

    // Check the timestamp first so a replayed body is rejected without hashing it.
    if (!validateTimestamp(flags['timestamp'], flags['window'])) {
      if (!flags['quiet']) this.log(`rejected: timestamp outside ${flags['window']}s window`);
      this.exit(1);
    }

    const valid = validateHmac(secret, flags['signature'], flags['timestamp'], await readStdin());

    if (!flags['quiet']) this.log(valid ? 'valid' : 'rejected: signature mismatch');
    this.exit(valid ? 0 : 1);
  }
}

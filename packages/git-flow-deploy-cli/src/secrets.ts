import { readFile } from 'node:fs/promises';

/**
 * Reads a secret from `<NAME>_FILE` if set, otherwise `<NAME>`.
 *
 * The file form is the one that matters in production: docker/swarm secrets are
 * mounted under /run/secrets rather than exported as environment variables, and a
 * value passed as an argument would be visible to anything that can read /proc.
 */
export async function readSecret(name: string): Promise<string> {
  const file = process.env[`${name}_FILE`];
  if (file) {
    const fromFile = (await readFile(file, 'utf-8')).trim();
    if (!fromFile) throw new Error(`${file} is empty`);
    return fromFile;
  }

  const value = process.env[name];
  if (!value) {
    throw new Error(`No value configured: set ${name} or ${name}_FILE`);
  }
  return value;
}

export async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

import { deploymentSlot, parseDeployYml } from '@cpdevtools/git-flow-deploy';
import { join } from 'node:path';

/**
 * Deployment slot declared by an extracted bundle.
 *
 * The slot is the identity a deployment is replaced under: compose uses it as
 * the project name and swarm as the stack name, and the service finds its own
 * container by the corresponding label. The CLI must derive it exactly as the
 * bundle's own deployCommand does, otherwise a CLI bootstrap and a later webhook
 * deploy manage two different stacks.
 *
 * Returns undefined when the manifest is missing or unreadable.
 */
export async function bundleSlot(
  extractDir: string,
): Promise<string | undefined> {
  try {
    const manifest = await parseDeployYml(join(extractDir, 'deploy.yml'));
    return (
      manifest.slot ??
      deploymentSlot(
        manifest.name,
        manifest.version,
        manifest.versioning ?? 'singleton',
      )
    );
  } catch {
    return undefined;
  }
}

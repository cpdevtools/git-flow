/**
 * Deployment slot helpers.
 *
 * A "slot" is the identity under which an app instance runs on the target host
 * and is replaced. It drives the compose project name, swarm stack name, the
 * pm2 app name, the per-slot durable state directory, and self-detection.
 *
 *   versioning: 'singleton' (default) → slot = safeName(name)
 *   versioning: 'major'               → slot = `${safeName(name)}-v${major}`
 *
 * With 'major', each MAJOR version runs as its own parallel instance (e.g. v1
 * and v2 of a REST API side by side); patches/minors within a major share a slot.
 */

export type VersioningStrategy = 'singleton' | 'major';

/** Convert a package name to a safe identifier (strips '@', replaces '/' with '-'). */
export function safeName(name: string): string {
  return name.replace(/@/g, '').replace(/\//g, '-');
}

/** Extract the major version number from a semver string (e.g. '1.2.3' → 1). */
export function majorVersion(version: string): number {
  const core = version.replace(/^v/, '').split('-')[0] ?? '';
  const major = parseInt(core.split('.')[0] ?? '', 10);
  return Number.isNaN(major) ? 0 : major;
}

/**
 * Compute the deployment slot for an app.
 * @param versioning defaults to 'singleton'.
 */
export function deploymentSlot(
  name: string,
  version: string,
  versioning: VersioningStrategy = 'singleton',
): string {
  const base = safeName(name);
  return versioning === 'major' ? `${base}-v${majorVersion(version)}` : base;
}

/** Docker-stack-safe variant of a slot (hyphens → underscores). */
export function slotStack(slot: string): string {
  return slot.replace(/-/g, '_');
}

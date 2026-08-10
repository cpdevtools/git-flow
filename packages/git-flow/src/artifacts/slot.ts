/**
 * Deployment slot helpers (pack-time mirror of git-flow-deploy's slot.ts).
 *
 * A "slot" is the identity under which an app instance runs on the target host
 * and is replaced. It drives the compose project name, swarm stack name, pm2
 * app name, per-slot state, and self-detection.
 *
 *   versioning: 'singleton' (default) → slot = safeName(name)
 *   versioning: 'major'               → slot = `${safeName(name)}-v${major}`
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

/** Compute the deployment slot for an app. `versioning` defaults to 'singleton'. */
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

/** Scope of a package name without the leading '@' (e.g. '@org/app' → 'org'); undefined when unscoped. */
export function packageScope(name: string): string | undefined {
  const match = /^@([^/]+)\//.exec(name);
  return match ? safeName(match[1]!) : undefined;
}

/** Package name without its scope (e.g. '@org/app' → 'app', 'app' → 'app'). */
export function packageService(name: string): string {
  return safeName(name.replace(/^@[^/]+\//, ''));
}

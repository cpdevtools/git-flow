/**
 * Plugin discovery.
 *
 * Installing a package is all that is required to enable it. There is no list to
 * maintain in `release-artifacts.yml` — that list existed only to make loading
 * happen, and loading now happens here.
 *
 * A dependency is treated as a plugin when either
 *   - its name matches `git-flow-plugin-*`, optionally scoped, or
 *   - its own package.json carries a `gitflow.plugin` key
 *
 * mirroring how the archived scaffold plans had org packages announce themselves
 * with a `cpdt` key (`old/plan-scaffoldRepo.prompt.md` §4.4).
 *
 * Resolution deliberately does not use a bare `import(name)`. This code runs from
 * the composite action's checkout (`${{ github.action_path }}/…`), so a bare
 * specifier resolves against the *action's* dependency tree and never reaches the
 * consuming repo's `node_modules`. Each candidate is resolved from the manifest
 * that declared it, then imported by file URL.
 */

import { createRequire } from 'node:module';
import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyPlugin } from './apply-plugin.js';
import { isGitFlowPlugin } from './plugin.js';
import type { PluginAnchor } from './provider-registry.js';

const PLUGIN_NAME_PATTERN = /^(@[^/]+\/)?git-flow-plugin-/;

/**
 * Walk up from `start` to the directory owning `pnpm-workspace.yaml`.
 *
 * That file is already the marker `discoverProjects` uses to tell a monorepo root
 * from a member package, so the two agree on what "the workspace" means. Falls
 * back to `start` for a standalone package with no workspace above it.
 */
export async function findWorkspaceRoot(start: string): Promise<string> {
  let dir = resolve(start);

  for (;;) {
    try {
      await access(join(dir, 'pnpm-workspace.yaml'));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return resolve(start);
      dir = parent;
    }
  }
}

export interface LoadPluginsOptions {
  /** Absolute path to the workspace root. */
  workspaceRoot: string;
  /** Absolute path to the project being processed, when there is one. */
  projectCwd?: string;
  /**
   * Plugins recorded in a previously written artifact descriptor. Replaying these
   * keeps later phases on exactly what pack resolved, rather than rediscovering
   * against a dependency tree that may have moved.
   */
  only?: string[];
}

export interface LoadedPlugin {
  name: string;
  version?: string;
  anchor: PluginAnchor;
  /** Directory whose package.json declared it — the resolution anchor. */
  from: string;
}

interface Manifest {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  gitflow?: { plugin?: unknown };
}

async function readManifest(dir: string): Promise<Manifest | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8')) as Manifest;
  } catch {
    return undefined;
  }
}

/**
 * Locate a resolved package's manifest by walking up from its entry file.
 *
 * Deliberately NOT `require.resolve(name + '/package.json')`: a package with an
 * `exports` map only exposes the subpaths it lists, and most authors do not
 * list `./package.json` — the resolve throws ERR_PACKAGE_PATH_NOT_EXPORTED for
 * a perfectly healthy, importable package. The filesystem does not care about
 * exports maps, and the entry always lives under the directory that owns the
 * manifest.
 *
 * Prefers the first package.json whose `name` matches: dual-format packages
 * plant bare `{"type": "commonjs"}` stubs in their dist directories, and the
 * nearest file is not always the real manifest.
 */
async function manifestAbove(
  entryFile: string,
  packageName: string,
): Promise<Manifest | undefined> {
  let dir = dirname(entryFile);
  let firstFound: Manifest | undefined;

  for (;;) {
    const manifest = await readManifest(dir);
    if (manifest) {
      if (manifest.name === packageName) return manifest;
      firstFound ??= manifest;
    }
    const parent = dirname(dir);
    if (parent === dir) return firstFound;
    dir = parent;
  }
}

/** Dependency names declared by a manifest, deduped. */
function declaredDependencies(manifest: Manifest): string[] {
  return [
    ...new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ]),
  ];
}

async function loadOne(
  packageName: string,
  anchorDir: string,
  anchor: PluginAnchor,
): Promise<LoadedPlugin | undefined> {
  const require = createRequire(join(anchorDir, 'package.json'));

  let entry: string;
  try {
    entry = require.resolve(packageName);
  } catch {
    // Declared but not installed — normal for an optional or filtered install.
    return undefined;
  }

  // Past this point the package IS installed, so failures must be loud: the
  // old subpath-resolve here classified an exports-map package as "not
  // installed" and silently skipped a working plugin.
  const manifest = await manifestAbove(entry, packageName);
  if (!manifest) {
    throw new Error(
      `'${packageName}' resolved to ${entry} but no package.json was found above it.`,
    );
  }
  const mod = (await import(pathToFileURL(entry).href)) as { default?: unknown };
  const exported = mod.default ?? mod;

  if (!isGitFlowPlugin(exported)) {
    throw new Error(
      `'${packageName}' looks like a git-flow plugin but its default export is not a plugin manifest.\n` +
        `Expected an object with a 'name', and optionally 'artifactTypes' / 'deployMethods' / 'register'.`,
    );
  }

  // The declared name is the provider key that `provider:` refers to, so a
  // mismatch with the installed package name would make it unaddressable.
  const provider = exported.name || packageName;
  await applyPlugin(exported, provider, anchor);

  return { name: provider, version: manifest.version, anchor, from: anchorDir };
}

function isCandidate(name: string, manifest: Manifest | undefined): boolean {
  return PLUGIN_NAME_PATTERN.test(name) || manifest?.gitflow?.plugin !== undefined;
}

/**
 * Discover and register every plugin reachable from the project and the
 * workspace root. Safe to call more than once in a process: registration is
 * idempotent per (key, provider).
 */
export async function loadPlugins(options: LoadPluginsOptions): Promise<LoadedPlugin[]> {
  const { workspaceRoot, projectCwd, only } = options;

  // Project first so its registrations are attributed to the more local anchor
  // when the same package is declared in both.
  const anchors: Array<{ dir: string; anchor: PluginAnchor }> = [];
  if (projectCwd && projectCwd !== workspaceRoot) {
    anchors.push({ dir: projectCwd, anchor: 'project' });
  }
  anchors.push({ dir: workspaceRoot, anchor: 'workspace' });

  const loaded: LoadedPlugin[] = [];
  const seen = new Set<string>();

  for (const { dir, anchor } of anchors) {
    const manifest = await readManifest(dir);
    if (!manifest) continue;

    for (const dep of declaredDependencies(manifest)) {
      if (seen.has(dep)) continue;
      if (only && !only.includes(dep)) continue;

      // Cheap name test first; only pay for resolving a manifest when a package
      // has to be inspected for the gitflow key.
      let candidate = PLUGIN_NAME_PATTERN.test(dep);
      if (!candidate) {
        // Same two-step split as loadOne: only "cannot resolve the entry" may
        // stay silent, because subpath-resolving package.json throws for any
        // package whose exports map does not list it — which would silently
        // drop every gitflow-key opt-in written that way.
        let depEntry: string;
        try {
          depEntry = createRequire(join(dir, 'package.json')).resolve(dep);
        } catch {
          continue;
        }
        candidate = isCandidate(dep, await manifestAbove(depEntry, dep));
      }
      if (!candidate) continue;

      const result = await loadOne(dep, dir, anchor);
      if (result) {
        // Marked seen only on success, so a dep that fails to resolve from this
        // anchor can still be picked up from the next one.
        seen.add(dep);
        loaded.push(result);
        console.log(
          `  🔌 Loaded plugin: ${result.name}${result.version ? `@${result.version}` : ''} (${anchor})`,
        );
      }
    }
  }

  return loaded;
}

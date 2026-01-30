import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { $ } from 'zx';

export interface ProjectConfig {
  name: string;
  version: string;
  cwd: string;
}

export interface RewriteNpmDepsOptions {
  project: ProjectConfig;
  allProjects: ProjectConfig[];
}

/**
 * Rewrite workspace:* dependencies to actual versions before packing
 */
export async function rewriteNpmWorkspaceDependencies(options: RewriteNpmDepsOptions): Promise<void> {
  const { project, allProjects } = options;
  const pkgPath = join(project.cwd, 'package.json');
  
  const content = await readFile(pkgPath, 'utf-8');
  const pkg = JSON.parse(content);

  // Create version lookup map
  const versionMap = new Map(
    allProjects.map(p => [p.name, p.version])
  );

  let modified = false;

  // Rewrite all dependency types
  for (const depType of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg[depType];
    if (!deps) continue;

    for (const [name, version] of Object.entries(deps)) {
      if (typeof version === 'string' && version.startsWith('workspace:')) {
        const actualVersion = versionMap.get(name);
        if (actualVersion) {
          deps[name] = actualVersion;
          modified = true;
          console.log(`  📝 Rewriting ${name}: ${version} → ${actualVersion}`);
        }
      }
    }
  }

  if (modified) {
    // Write updated package.json
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  }
}

/**
 * Restore original package.json from git
 */
export async function restorePackageJson(projectCwd: string): Promise<void> {
  const pkgPath = join(projectCwd, 'package.json');
  await $({ cwd: projectCwd })`git checkout ${pkgPath}`;
}

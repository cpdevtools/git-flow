import fg from 'fast-glob';
import { readFile, access } from 'fs/promises';
import { join, dirname } from 'path';

export interface Project {
  /** Project name extracted from package.json */
  name: string;
  /** Working directory path */
  directory: string;
  /** Package.json content */
  packageJson: any;
  /** Project dependencies */
  dependencies: string[];
}

export interface DependencyGraph {
  /** Map of project names to their dependencies */
  dependencies: Map<string, string[]>;
  /** Ordered batches for parallel execution */
  batches: Project[][];
  /** Get topological batches (legacy method) */
  getTopologicalBatches(): Project[][];
}

/**
 * Discover projects in workspace
 */
export async function discoverProjects(workspaceRoot: string): Promise<Project[]> {
  const packageJsonPaths = await fg(['**/package.json'], {
    cwd: workspaceRoot,
    followSymbolicLinks: false,
    ignore: [
      '**/node_modules/**',
      '**/.pnpm-prod/**',
      '**/.docker-bundle/**',
      '**/.wireit/**',
      '**/dist/**',
    ],
  });

  const projects: Project[] = [];

  for (const packagePath of packageJsonPaths) {
    const fullPath = join(workspaceRoot, packagePath);
    const directory = dirname(fullPath);

    // Skip the workspace root — a directory that owns a pnpm-workspace.yaml
    // is a monorepo root, not a publishable project member.
    try {
      await access(join(directory, 'pnpm-workspace.yaml'));
      continue;
    } catch {
      // No workspace file — this is a regular package, proceed.
    }

    try {
      const content = await readFile(fullPath, 'utf-8');
      const packageJson = JSON.parse(content);

      if (packageJson.name) {
        projects.push({
          name: packageJson.name,
          directory,
          packageJson,
          dependencies: [],
        });
      }
    } catch (error) {
      console.error(`Failed to parse ${packagePath}:`, error);
    }
  }

  return projects;
}

/**
 * Build dependency graph for projects
 */
export function buildDependencyGraph(projects: Project[]): DependencyGraph {
  const dependencies = new Map<string, string[]>();

  // Simple implementation - no dependencies for now
  projects.forEach((project) => {
    dependencies.set(project.name, []);
  });

  const batches = [projects]; // Return the actual Project objects

  return {
    dependencies,
    batches,
    getTopologicalBatches: () => batches,
  };
}

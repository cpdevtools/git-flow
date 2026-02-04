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
  const fg = (await import('fast-glob')).default;
  const fs = await import('fs/promises');
  const path = await import('path');

  const packageJsonPaths = await fg(['**/package.json'], {
    cwd: workspaceRoot,
    ignore: ['**/node_modules/**']
  });

  const projects: Project[] = [];

  for (const packagePath of packageJsonPaths) {
    const fullPath = path.join(workspaceRoot, packagePath);
    const directory = path.dirname(fullPath);
    
    try {
      const content = await fs.readFile(fullPath, 'utf-8');
      const packageJson = JSON.parse(content);
      
      if (packageJson.name) {
        projects.push({
          name: packageJson.name,
          directory,
          packageJson,
          dependencies: []
        });
      }
    } catch (error) {
      console.warn(`Failed to parse ${packagePath}:`, error);
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
  projects.forEach(project => {
    dependencies.set(project.name, []);
  });

  const batches = [projects]; // Return the actual Project objects

  return {
    dependencies,
    batches,
    getTopologicalBatches: () => batches
  };
}
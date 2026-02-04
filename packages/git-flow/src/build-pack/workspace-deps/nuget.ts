import { readFile, writeFile } from 'fs/promises';
import { $ } from 'zx';
import fg from 'fast-glob';

export interface ProjectConfig {
  name: string;
  version: string;
  cwd: string;
}

export interface RewriteNugetDepsOptions {
  project: ProjectConfig;
  allProjects: ProjectConfig[];
}

/**
 * Convert ProjectReference to PackageReference before packing
 */
export async function rewriteNugetProjectReferences(options: RewriteNugetDepsOptions): Promise<void> {
  const { project, allProjects } = options;

  // Find all .csproj files
  const csprojFiles = await fg('**/*.csproj', {
    cwd: project.cwd,
    absolute: true,
    gitignore: true,
  });

  if (csprojFiles.length === 0) {
    return;
  }

  // Create version lookup map
  const versionMap = new Map(
    allProjects.map(p => [p.name, p.version])
  );

  for (const csprojPath of csprojFiles) {
    const content = await readFile(csprojPath, 'utf-8');
    let modified = content;
    let hasChanges = false;

    // Find ProjectReference elements
    const projectRefRegex = /<ProjectReference\s+Include="([^"]+)"\s*\/>/g;
    const matches = [...content.matchAll(projectRefRegex)];

    for (const match of matches) {
      const includePath = match[1];
      
      // Try to find matching project by path
      for (const otherProject of allProjects) {
        if (otherProject.name === project.name) continue;
        
        // Simple heuristic: if path contains project folder name
        if (includePath.includes(otherProject.name)) {
          const packageRef = `<PackageReference Include="${otherProject.name}" Version="${otherProject.version}" />`;
          modified = modified.replace(match[0], packageRef);
          hasChanges = true;
          console.log(`  📝 Converting ${otherProject.name}: ProjectReference → PackageReference`);
          break;
        }
      }
    }

    if (hasChanges) {
      await writeFile(csprojPath, modified);
    }
  }
}

/**
 * Restore original .csproj files from git
 */
export async function restoreCsprojFiles(projectCwd: string): Promise<void> {
  const csprojFiles = await fg('**/*.csproj', {
    cwd: projectCwd,
    absolute: true,
    gitignore: true,
  });

  for (const csprojPath of csprojFiles) {
    await $({ cwd: projectCwd })`git checkout ${csprojPath}`.catch(() => {
      // Ignore errors - file may not be tracked
    });
  }
}

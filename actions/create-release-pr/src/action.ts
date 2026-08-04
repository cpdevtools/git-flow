import * as core from '@actions/core';
import * as github from '@actions/github';
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { resolveVersion } from '@cpdevtools/git-flow/version';
import { parseJson } from '@cpdevtools/ts-dev-utilities/json';
import { discoverProjects, detectDraftReleases } from '@cpdevtools/git-flow/build-pack';

interface VersionsConfig {
  [placeholder: string]: string;
}

interface ProjectMetadata {
  name: string;
  version: string;
  resolvedVersion: string;
  isPreRelease: boolean;
}

async function run() {
  try {
    core.info('🚀 create-release-pr action v2 - checking GitHub releases for existing versions');
    
    // Get inputs
    const branch = core.getInput('branch', { required: true });
    const token = core.getInput('token', { required: true });
    const versionsFile = core.getInput('versions_file') || '.publish/versions.yml';
    const runNumber = parseInt(core.getInput('run_number') || '0', 10);

    // Set GITHUB_TOKEN for gh CLI commands in version resolution
    process.env.GITHUB_TOKEN = token;
    core.info(`Token set for gh CLI (length: ${token.length})`);

    core.info(`Creating release PR for branch: ${branch}`);
    core.info(`Run number: ${runNumber}`);

    // Load versions configuration (supports both JSON and YAML)
    const versionsContent = await readFile(versionsFile, 'utf-8');
    const isYaml = versionsFile.endsWith('.yml') || versionsFile.endsWith('.yaml');
    const versionsByPlaceholder = (isYaml
      ? parseYaml(versionsContent)
      : parseJson(versionsContent)) as VersionsConfig;
    core.info(`Loaded versions from ${versionsFile}: ${JSON.stringify(versionsByPlaceholder)}`);

    // Discover projects in workspace
    const projects = await discoverProjects(process.cwd());
    core.info(`Found ${projects.length} projects`);

    // Filter to only projects with github.actions.pack script (opt-in to release flow)
    const buildableProjects = projects.filter(project => {
      const hasPackScript = !!project.packageJson.scripts?.['github.actions.pack'];
      if (!hasPackScript) {
        core.info(`Skipping ${project.packageJson.name}: no github.actions.pack script`);
      }
      return hasPackScript;
    });
    core.info(`${buildableProjects.length} projects have github.actions.pack script`);

    // Resolve versions for each project
    const projectMetadata: Array<ProjectMetadata & { cwd: string }> = [];
    
    for (const project of buildableProjects) {
      const packageVersion = project.packageJson.version;
      if (!packageVersion) {
        core.warning(`Skipping ${project.packageJson.name}: no version in package.json`);
        continue;
      }

      try {
        const result = await resolveVersion({
          placeholder: packageVersion,
          branch,
          versionsByPlaceholder,
          runNumber,
          projectName: project.packageJson.name,
        });

        projectMetadata.push({
          name: project.packageJson.name || 'unknown',
          version: packageVersion,
          resolvedVersion: result.version,
          isPreRelease: result.isPreRelease,
          cwd: project.directory,
        });

        core.info(
          `${project.packageJson.name}: ${packageVersion} → ${result.version} (pre-release: ${result.isPreRelease})`,
        );
      } catch (error) {
        core.warning(
          `Failed to resolve version for ${project.packageJson.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Group projects by placeholder
    const projectsByPlaceholder: Record<string, typeof projectMetadata> = {};
    for (const project of projectMetadata) {
      // Extract placeholder from version (e.g., '0.0.0-DEFAULT' -> 'DEFAULT')
      const placeholderMatch = project.version.match(/0\.0\.0-(.+)/);
      const placeholder = placeholderMatch ? placeholderMatch[1] : 'DEFAULT';
      
      if (!projectsByPlaceholder[placeholder]) {
        projectsByPlaceholder[placeholder] = [];
      }
      projectsByPlaceholder[placeholder].push(project);
    }

    // Normalize: all projects in the same version group must resolve to the same version.
    // Per-project resolution can produce different versions when some packages have existing
    // tags (and get bumped) while new packages in the same group don't (and stay at base).
    for (const [placeholder, groupProjects] of Object.entries(projectsByPlaceholder)) {
      const uniqueVersions = [...new Set(groupProjects.map(p => p.resolvedVersion))];
      if (uniqueVersions.length <= 1) continue;

      // Pick the "latest" version — a bumped version (e.g. 1.0.0-rc.78.build.0) always
      // sorts after the base (1.0.0-rc.78) because the extra segments extend the string.
      const groupVersion = [...uniqueVersions].sort().pop()!;

      core.warning(
        `Version group '${placeholder}' has mixed versions [${uniqueVersions.join(', ')}] — normalizing all to ${groupVersion}`,
      );
      for (const p of groupProjects) {
        if (p.resolvedVersion !== groupVersion) {
          core.info(`  ${p.name}: ${p.resolvedVersion} → ${groupVersion}`);
          p.resolvedVersion = groupVersion;
        }
      }
    }

    // Create release branch name
    const releaseBranch = `release/${branch}`;
    core.info(`Release branch: ${releaseBranch}`);

    // Initialize GitHub client
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    // Check if draft releases exist for any projects
    const allProjects = Object.values(projectsByPlaceholder).flat();
    const hasDraftReleases = await detectDraftReleases(
      token,
      owner,
      repo,
      allProjects.map(p => ({ name: p.name, version: p.resolvedVersion }))
    );
    
    if (hasDraftReleases) {
      core.info('⚠️  Draft releases detected from a previous attempt');
    }

    // Get current commit SHA
    const { data: refData } = await octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${branch}`,
    });
    const sha = refData.object.sha;
    core.info(`Current SHA: ${sha}`);

    // Create or get reference to release branch
    let releaseBranchCreated = false;
    try {
      await octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${releaseBranch}`,
        sha,
      });
      core.info(`Created release branch: ${releaseBranch}`);
      releaseBranchCreated = true;
    } catch (error: any) {
      if (error.status === 422) {
        // Branch already exists - don't update it
        core.info(`Release branch already exists: ${releaseBranch}`);
      } else {
        throw error;
      }
    }

    // Generate PR body with metadata
    const metadata = {
      branch,
      runNumber,
      sha,
      projectsByPlaceholder,
      generatedAt: new Date().toISOString(),
    };

    const prBody = `## Release from \`${branch}\`

### Metadata

\`\`\`yaml
${generateYamlMetadata(metadata)}
\`\`\`
${hasDraftReleases ? `
### Build Options

- [ ] Force Rebuild (delete existing drafts and rebuild all artifacts)

> ⚠️ Draft releases detected from a previous attempt. Check "Force Rebuild" to delete existing drafts and rebuild everything, or leave unchecked to resume from existing artifacts.
` : ''}
### Projects

| Name | Version Group | Version | Pre-release |
|------|---------------|---------|-------------|
${Object.entries(projectsByPlaceholder)
  .flatMap(([placeholder, projects]) => 
    projects.map((p) => `| ${p.name} | ${placeholder} | ${p.resolvedVersion} | ${p.isPreRelease ? '✓' : ''} |`)
  )
  .join('\n')}

---
*Generated by create-release-pr action*
`;

    // Check if PR already exists
    const { data: existingPRs } = await octokit.rest.pulls.list({
      owner,
      repo,
      head: `${owner}:${branch}`,
      base: releaseBranch,
      state: 'open',
    });

    // Check if branches have differences
    const { data: comparison } = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${releaseBranch}...${branch}`,
    });

    const hasDifferences = comparison.ahead_by > 0 || comparison.behind_by > 0;

    if (!hasDifferences) {
      core.info('No differences between branches');

      if (releaseBranchCreated) {
        core.warning(
          `${releaseBranch} did not exist and was created at the current tip of ${branch}, so there is nothing to compare and no release PR can be opened yet. ` +
            `GitHub will not accept a pull request with no commits between the branches. ` +
            `Either push another commit to ${branch}, or reset ${releaseBranch} back to the last commit you consider released ` +
            `(e.g. \`git push --force-with-lease origin <last-released-sha>:refs/heads/${releaseBranch}\`) and re-run this workflow.`,
        );
      }

      // Close any existing PR since there are no changes
      if (existingPRs.length > 0) {
        const pr = existingPRs[0];
        await octokit.rest.pulls.update({
          owner,
          repo,
          pull_number: pr.number,
          state: 'closed',
        });
        core.info(`Closed PR #${pr.number} (no differences)`);
      }
      
      core.info('✅ No PR needed - branches are identical');
      core.setOutput('pr-number', '');
      core.setOutput('pr-url', '');
      core.setOutput('release-branch', releaseBranch);
      return;
    }

    let prNumber: number;
    let prUrl: string;

    if (existingPRs.length > 0) {
      // Update existing PR
      const pr = existingPRs[0];
      const { data: updatedPR } = await octokit.rest.pulls.update({
        owner,
        repo,
        pull_number: pr.number,
        body: prBody,
      });
      prNumber = updatedPR.number;
      prUrl = updatedPR.html_url;
      core.info(`Updated existing PR #${prNumber}`);
    } else {
      // Create new PR
      const { data: newPR } = await octokit.rest.pulls.create({
        owner,
        repo,
        title: `Release from ${branch}`,
        head: branch,
        base: releaseBranch,
        body: prBody,
        draft: true,
      });
      prNumber = newPR.number;
      prUrl = newPR.html_url;
      core.info(`Created new PR #${prNumber}`);
    }

    // Set outputs
    core.setOutput('pr-number', prNumber);
    core.setOutput('pr-url', prUrl);
    core.setOutput('release-branch', releaseBranch);

    core.info(`✅ Success! PR: ${prUrl}`);
  } catch (error) {
    core.setFailed(`Action failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function generateYamlMetadata(metadata: any): string {
  const yaml: string[] = [];

  for (const [placeholder, projects] of Object.entries(metadata.projectsByPlaceholder)) {
    yaml.push(`${placeholder}:`);
    
    // Calculate group-level tags
    const versionGroup = placeholder;
    const firstProject = (projects as any[])[0];
    if (firstProject) {
      const groupTags = [`v${firstProject.resolvedVersion}/${versionGroup}`];
      
      // Add simple version tag for MAIN group only
      if (versionGroup === 'MAIN') {
        groupTags.push(`v${firstProject.resolvedVersion}`);
      }
      
      yaml.push(`  tags:`);
      for (const tag of groupTags) {
        yaml.push(`    - ${tag}`);
      }
    }
    
    yaml.push(`  projects:`);
    for (const project of projects as any[]) {
      // Calculate project-specific tag
      const packageTag = `v${project.resolvedVersion}/${project.name}`;
      
      yaml.push(`    - name: ${project.name}`);
      yaml.push(`      version: ${project.resolvedVersion}`);
      yaml.push(`      prerelease: ${project.isPreRelease}`);
      yaml.push(`      cwd: ${project.cwd}`);
      yaml.push(`      tags:`);
      yaml.push(`        - ${packageTag}`);
    }
  }

  return yaml.join('\n');
}

run();

/**
 * Build and pack execution functions
 */

import type { ProjectArtifactDescriptor } from '@cpdevtools/ts-dev-utilities/artifacts';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import nunjucks from 'nunjucks';
import { parse, parseDocument, stringify } from 'yaml';
import { $ } from 'zx';
import {
  getArtifactType,
  getDeployMethod,
  listDeployMethods,
  type Artifact,
  type DeployMethodContext,
  type UploadContext,
} from '../artifacts/index.js';
import {
  deploymentSlot,
  safeName,
  packageScope,
  packageService,
  majorVersion,
  type VersioningStrategy,
} from '../artifacts/slot.js';
import { findOrCreateDraftRelease, uploadArtifact, markReleasePublished } from './github.js';
import {
  generateArtifactDescriptor,
  loadArtifactConfig,
  ARTIFACT_OUTPUT_DIR,
} from './generate-artifact.js';
import type { BuildPackContext, ExecutionResult, ProjectConfig } from './types.js';
import { rewriteWorkspaceDependencies, restoreProjectFiles } from './workspace-deps/index.js';

/**
 * Apply version to package.json
 */
async function applyVersionToPackageJson(cwd: string, version: string): Promise<void> {
  const pkgPath = join(cwd, 'package.json');

  if (!existsSync(pkgPath)) {
    return;
  }

  const content = await readFile(pkgPath, 'utf-8');
  const pkg = JSON.parse(content);

  pkg.version = version;

  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

/**
 * Apply version to .csproj files
 */
async function applyVersionToCsproj(cwd: string, version: string): Promise<void> {
  // Find all .csproj files
  try {
    const { stdout } = await $({ cwd })`find . -maxdepth 1 -name "*.csproj"`;
    const csprojFiles = stdout.trim().split('\n').filter(Boolean);

    for (const csprojFile of csprojFiles) {
      const csprojPath = join(cwd, csprojFile);
      let content = await readFile(csprojPath, 'utf-8');

      // Update <Version> tag
      if (content.includes('<Version>')) {
        content = content.replace(/<Version>.*?<\/Version>/, `<Version>${version}</Version>`);
      } else {
        // Add Version tag if not present
        content = content.replace(
          /<PropertyGroup>/,
          `<PropertyGroup>\n    <Version>${version}</Version>`,
        );
      }

      await writeFile(csprojPath, content);
    }
  } catch (error) {
    // No .csproj files found, that's OK
  }
}

/**
 * Apply version to project files
 */
export async function applyVersion(cwd: string, version: string): Promise<void> {
  await applyVersionToPackageJson(cwd, version);
  await applyVersionToCsproj(cwd, version);
}

/**
 * Read package.json for a project
 */
async function readPackageJson(cwd: string): Promise<any> {
  const pkgPath = join(cwd, 'package.json');
  const content = await readFile(pkgPath, 'utf-8');
  return JSON.parse(content);
}

/**
 * Check if project has a pack script
 */
async function hasPackScript(project: ProjectConfig): Promise<boolean> {
  const packageJson = await readPackageJson(project.cwd);
  return !!packageJson.scripts?.['github.actions.pack'];
}

/**
 * Execute pack script for a project
 * @param project - Project configuration
 * @param context - Workflow context
 * @returns Execution result
 */
/**
 * Execute pack script for a project with workspace dependency rewriting
 * @param project - Project configuration
 * @param context - Workflow context (must include allProjects for dependency resolution)
 * @returns Execution result
 */
export async function executePack(
  project: ProjectConfig,
  context: BuildPackContext,
): Promise<ExecutionResult> {
  if (!(await hasPackScript(project))) {
    console.log(`⊘ ${project.name}: No pack script, skipping...`);
    return {
      project: project.name,
      success: true,
    };
  }

  console.log(`📦 ${project.name}: Packing & generating artifact descriptor...`);

  try {
    // Set environment variables
    const artifactFilename = project.name.replace(/@/g, '').replace(/\//g, '-');
    const env = {
      ...process.env,
      PROJECT_VERSION: project.version,
      PROJECT_NAME: project.name,
      ARTIFACT_OUTPUT_DIR,
      ARTIFACT_FILENAME: artifactFilename,
      GITHUB_SHA: context.sha,
    } as Record<string, string>;

    // Rewrite workspace dependencies before packing
    console.log(`  🔄 Rewriting workspace dependencies...`);
    await rewriteWorkspaceDependencies({
      project,
      allProjects: context.allProjects || [project],
    });

    // The descriptor path produced by packing.  Must be generated while the
    // project files are still bumped/rewritten (before restoreProjectFiles).
    const artifactPath = join(ARTIFACT_OUTPUT_DIR, `${artifactFilename}.artifact.yml`);

    // Execute pack script
    let result;
    try {
      // Verify CLI is available
      try {
        await $({ cwd: project.cwd, env })`which gitflow`;
        console.log(`  ✓ gitflow CLI found in PATH`);
      } catch {
        console.error(`  ⚠️  gitflow not found in PATH`);
        console.error(`  PATH: ${env.PATH}`);
      }

      result = await $({ cwd: project.cwd, env, verbose: true })`pnpm run github.actions.pack`;
      console.log(`  ✓ Pack completed`);

      // Generate the descriptor while files are still bumped/rewritten.
      // If the pack script already produced it (e.g. `gitflow pack`), skip to
      // avoid re-running pack handlers (which would re-pack / re-push docker).
      if (!existsSync(artifactPath)) {
        await generateArtifactDescriptor(project.cwd, project.name, project.version);
      }
    } catch (error) {
      console.error(`  ✗ Pack failed:`, error);
      throw error;
    } finally {
      // Always restore files, even if pack fails
      console.log(`  ↩️  Restoring original project files...`);
      await restoreProjectFiles(project.cwd);
    }

    if (!existsSync(artifactPath)) {
      throw new Error(`Artifact descriptor was not generated: ${artifactPath}`);
    }

    console.log(`✓ ${project.name}: Pack completed, artifact descriptor generated`);

    return {
      project: project.name,
      success: true,
      exitCode: result.exitCode ?? 0,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`✗ ${project.name}: Pack failed - ${errorMessage}`);

    return {
      project: project.name,
      success: false,
      error: errorMessage,
      exitCode: 1,
    };
  }
}

/**
 * Template delimiters for deploy files.
 *
 * Deliberately not `{{ }}`/`${ }`: the rendered output still contains literal
 * `${VAR}` that `docker stack deploy` interpolates at deploy time, and that must
 * survive this pass untouched.
 */
const DEPLOY_TEMPLATE_TAGS = {
  variableStart: '@{',
  variableEnd: '}',
  blockStart: '@%',
  blockEnd: '%@',
  commentStart: '@#',
  commentEnd: '#@',
};

/**
 * Render every text file under `dir` as a nunjucks template.
 *
 * Runs at pack time — after all source files are in the deploy output dir and
 * deploy.yml has been generated — so baked-in values like `@{ SERVICE_ID }` work
 * in places where runtime env interpolation doesn't (e.g. YAML map keys).
 *
 * `file()` returns a sibling's *rendered* content, so a checksum taken over it
 * covers the bytes that actually ship. Results are memoized, so each file is
 * rendered once no matter which order the walk reaches it in.
 */
export async function renderDeployTemplates(
  dir: string,
  values: Record<string, string>,
): Promise<void> {
  const root = resolve(dir);
  const env = new nunjucks.Environment(null, {
    autoescape: false,
    throwOnUndefined: true,
    tags: DEPLOY_TEMPLATE_TAGS,
  });

  const rendered = new Map<string, string>();
  const active = new Set<string>();

  const readRendered = (templatePath: string): string => {
    const target = resolve(root, templatePath);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`file() escapes the deploy bundle: ${templatePath}`);
    }
    const key = relative(root, target);
    const cached = rendered.get(key);
    if (cached !== undefined) return cached;
    if (active.has(key)) {
      throw new Error(`Circular file() reference in deploy templates: ${key}`);
    }
    active.add(key);
    try {
      return render(key, readFileSync(target, 'utf-8'));
    } finally {
      active.delete(key);
    }
  };

  const context: Record<string, unknown> = {
    ...values,
    file: readRendered,
    sha256: (input: string) => createHash('sha256').update(String(input)).digest('hex'),
    shortHash: (input: string) =>
      createHash('sha256').update(String(input)).digest('hex').slice(0, 12),
    now: () => Date.now(),
    envVar: (name: string, fallback = '') => process.env[name] ?? fallback,
  };

  const render = (key: string, content: string): string => {
    let output: string;
    try {
      output = env.renderString(content, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to render deploy template '${key}': ${message}`);
    }
    rendered.set(key, output);
    return output;
  };

  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      let content: string;
      try {
        content = readFileSync(fullPath, 'utf-8');
      } catch {
        continue;
      }
      if (content.includes('\0')) continue; // binary file
      const key = relative(root, fullPath);
      const output = rendered.get(key) ?? render(key, content);
      if (output !== content) writeFileSync(fullPath, output, 'utf-8');
    }
  };

  walk(root);
}

/**
 * Build the value map exposed to deploy templates.
 */
export function deployContext(
  projectName: string,
  version: string,
  versioning: VersioningStrategy,
  stackOverride?: string,
  serviceOverride?: string,
): Record<string, string> {
  const service = serviceOverride ?? packageService(projectName);
  const stack = stackOverride ?? packageScope(projectName) ?? service;
  const serviceId = versioning === 'major' ? `${service}_v${majorVersion(version)}` : service;
  return {
    SERVICE: service,
    SERVICE_ID: serviceId,
    STACK: stack,
    // What docker names the running service: the stack prefix joined to the
    // service key (SERVICE_ID) with '_', matching `docker service ls`.
    STACK_SERVICE_ID: `${stack}_${serviceId}`,
    // Same join, unversioned — stable across coexisting majors.
    STACK_SERVICE: `${stack}_${service}`,
    VERSION: version,
    MAJOR: String(majorVersion(version)),
  };
}

/**
 * Validate an artifact's `sharedStorage` declaration from release-artifacts.yml.
 *
 * Mirrors the manifest-side rules in @cpdevtools/git-flow-deploy so a bad value
 * fails at pack time rather than mid-deploy.
 */
export function normalizeSharedStorage(
  raw: unknown,
  artifactLabel: string,
): boolean | string[] | { shared?: string[]; versioned?: string[] } | undefined {
  if (raw === undefined || raw === false) return undefined;
  if (raw === true) return true;
  const validateEntry = (entry: unknown, index: number, field: string): string => {
    if (typeof entry !== 'string' || entry === '') {
      throw new Error(`${field}[${index}] on artifact '${artifactLabel}' must be a non-empty string`);
    }
    if (entry.startsWith('/')) {
      throw new Error(`${field}[${index}] on artifact '${artifactLabel}' must be a relative path: ${entry}`);
    }
    if (entry.split('/').includes('..')) {
      throw new Error(`${field}[${index}] on artifact '${artifactLabel}' must not contain '..': ${entry}`);
    }
    return entry;
  };
  if (Array.isArray(raw)) {
    return raw.map((entry, index) => validateEntry(entry, index, 'sharedStorage'));
  }
  if (typeof raw === 'object' && raw !== null) {
    const obj = raw as { shared?: unknown; versioned?: unknown };
    const spec: { shared?: string[]; versioned?: string[] } = {};
    if (obj.shared !== undefined) {
      if (!Array.isArray(obj.shared)) {
        throw new Error(
          `sharedStorage.shared on artifact '${artifactLabel}' must be an array of relative paths.`,
        );
      }
      spec.shared = obj.shared.map((e, i) => validateEntry(e, i, 'sharedStorage.shared'));
    }
    if (obj.versioned !== undefined) {
      if (!Array.isArray(obj.versioned)) {
        throw new Error(
          `sharedStorage.versioned on artifact '${artifactLabel}' must be an array of relative paths.`,
        );
      }
      spec.versioned = obj.versioned.map((e, i) => validateEntry(e, i, 'sharedStorage.versioned'));
    }
    return spec;
  }
  throw new Error(
    `Invalid sharedStorage on artifact '${artifactLabel}': expected true, an array of relative paths, or { shared, versioned }.`,
  );
}

/**
 * Validate an artifact's `seedStorage` declaration from release-artifacts.yml.
 *
 * Mirrors the manifest-side rules in @cpdevtools/git-flow-deploy so a bad value
 * fails at pack time rather than mid-deploy.
 */
export function normalizeSeedStorage(
  raw: unknown,
  artifactLabel: string,
): { from: string; to: string }[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(
      `Invalid seedStorage on artifact '${artifactLabel}': expected an array of { from, to } objects.`,
    );
  }
  return raw.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(
        `seedStorage[${index}] on artifact '${artifactLabel}' must be an object with 'from' and 'to'`,
      );
    }
    const { from, to } = entry as { from?: unknown; to?: unknown };
    for (const [key, value] of [
      ['from', from],
      ['to', to],
    ] as const) {
      if (typeof value !== 'string' || value === '') {
        throw new Error(
          `seedStorage[${index}].${key} on artifact '${artifactLabel}' must be a non-empty string`,
        );
      }
      if (value.startsWith('/')) {
        throw new Error(
          `seedStorage[${index}].${key} on artifact '${artifactLabel}' must be a relative path: ${value}`,
        );
      }
      if (value.split('/').includes('..')) {
        throw new Error(
          `seedStorage[${index}].${key} on artifact '${artifactLabel}' must not contain '..': ${value}`,
        );
      }
    }
    return { from: from as string, to: to as string };
  });
}

/**
 *
 * Resolution chain per (artifact, method) pair — first match wins:
 *   1. .deploy/{method}/ folder   — copy files; fall through to handler.generateDeployYml
 *                                   if deploy.yml is absent from the folder
 *   2. github.actions.pack-deploy-{method} script — run it (ARTIFACT_TYPE env set)
 *   3. Registered DeployMethodHandler — call copyFiles then generateDeployYml
 *
 * Legacy path (backward compat): no artifact carries a `deploy:` array but the
 * project has a github.actions.pack-deploy script.
 */
async function executePackDeploy(
  project: ProjectConfig,
  context: BuildPackContext,
  descriptor: ProjectArtifactDescriptor,
  uploadCtx: UploadContext,
): Promise<void> {
  type WithDeploy = {
    deploy?: string[];
    versioning?: string;
    stack?: string;
    service?: string;
    sharedStorage?: unknown;
    seedStorage?: unknown;
  };
  const artifactsWithDeploy = descriptor.artifacts.filter(
    (a: Artifact) =>
      Array.isArray((a as unknown as WithDeploy).deploy) &&
      ((a as unknown as WithDeploy).deploy as string[]).length > 0,
  );

  if (artifactsWithDeploy.length > 0) {
    // ── New convention-based path ──────────────────────────────────────────
    const packageJson = await readPackageJson(project.cwd);
    for (const artifact of artifactsWithDeploy) {
      const methods = (artifact as unknown as WithDeploy).deploy as string[];
      const rawVersioning = (artifact as unknown as WithDeploy).versioning;
      if (
        rawVersioning !== undefined &&
        rawVersioning !== 'singleton' &&
        rawVersioning !== 'major'
      ) {
        throw new Error(
          `Invalid versioning '${rawVersioning}' on artifact '${(artifact as { name?: string }).name ?? artifact.type}': expected 'singleton' or 'major'.`,
        );
      }
      const versioning = (rawVersioning ?? 'singleton') as VersioningStrategy;
      // Opt-in for hosts that run many services in one shared stack; default is
      // a stack per slot.
      const stackOverride = (artifact as unknown as WithDeploy).stack;
      if (
        stackOverride !== undefined &&
        (typeof stackOverride !== 'string' || stackOverride.trim() === '')
      ) {
        throw new Error(
          `Invalid stack on artifact '${(artifact as { name?: string }).name ?? artifact.type}': expected a non-empty string.`,
        );
      }
      // Overrides the unscoped package name as the SERVICE token / storage segment.
      const serviceOverride = (artifact as unknown as WithDeploy).service;
      if (
        serviceOverride !== undefined &&
        (typeof serviceOverride !== 'string' || serviceOverride.trim() === '')
      ) {
        throw new Error(
          `Invalid service on artifact '${(artifact as { name?: string }).name ?? artifact.type}': expected a non-empty string.`,
        );
      }
      const sharedStorage = normalizeSharedStorage(
        (artifact as unknown as WithDeploy).sharedStorage,
        (artifact as { name?: string }).name ?? artifact.type,
      );
      const seedStorage = normalizeSeedStorage(
        (artifact as unknown as WithDeploy).seedStorage,
        (artifact as { name?: string }).name ?? artifact.type,
      );
      for (const method of methods) {
        // Parallel-major deploys are only supported for compose/swarm today
        // (node's pm2 identity + port binding are author-controlled).
        if (versioning === 'major' && method !== 'compose' && method !== 'swarm') {
          throw new Error(
            `versioning: major is only supported for compose/swarm deploy methods, not '${method}' ` +
              `(artifact '${(artifact as { name?: string }).name ?? artifact.type}'). node multi-version is not yet supported.`,
          );
        }
        console.log(`  \ud83d\ude80 ${project.name}: pack-deploy-${method}...`);

        const deployOutputDir = join(project.cwd, '.deploy-output', method);
        await mkdir(deployOutputDir, { recursive: true });

        const deployCtx: DeployMethodContext = {
          projectCwd: project.cwd,
          deployOutputDir,
          projectName: project.name,
          version: project.version,
          method,
          versioning,
          stack: stackOverride,
        };

        const env = {
          ...process.env,
          PROJECT_VERSION: project.version,
          PROJECT_NAME: project.name,
          ARTIFACT_TYPE: artifact.type,
          ARTIFACT_OUTPUT_DIR,
          DEPLOY_OUTPUT_DIR: deployOutputDir,
          GITHUB_RELEASE_ID: String(uploadCtx.releaseId),
          GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY ?? '',
          GITHUB_SHA: context.sha,
        } as Record<string, string>;

        // ── Step 1: .deploy/{method}/ folder ────────────────────────────────
        const folderPath = join(project.cwd, '.deploy', method);
        if (existsSync(folderPath)) {
          console.log(`    \ud83d\udcc1 Using .deploy/${method}/ override folder`);
          await cp(folderPath, deployOutputDir, { recursive: true });
          // Fall through for deploy.yml if the folder didn't include one
          if (!existsSync(join(deployOutputDir, 'deploy.yml'))) {
            const handler = getDeployMethod(artifact.type, method);
            if (!handler) {
              throw new Error(
                `No deploy method handler for ${artifact.type}.${method} \u2014 needed to generate deploy.yml.\n` +
                  `The .deploy/${method}/ folder exists but contains no deploy.yml and no handler is registered.\n` +
                  `Registered methods for '${artifact.type}': ${listDeployMethods(artifact.type).join(', ') || '(none)'}`,
              );
            }
            await handler.generateDeployYml(deployCtx);
          }
        }
        // ── Step 2: github.actions.pack-deploy-{method} script ──────────────
        else if (packageJson.scripts?.[`github.actions.pack-deploy-${method}`]) {
          await $({ cwd: project.cwd, env })`pnpm run github.actions.pack-deploy-${method}`;
        }
        // ── Step 3: Registry handler ─────────────────────────────────────────
        else {
          // Load artifact config to trigger plugin side-effects in this process
          await loadArtifactConfig(project.cwd, {
            PROJECT_NAME: project.name,
            ARTIFACT_OUTPUT_DIR,
            PACKAGE_NAME: project.name,
            PACKAGE_VERSION: project.version,
          });
          const handler = getDeployMethod(artifact.type, method);
          if (!handler) {
            throw new Error(
              `No deploy handler found for ${artifact.type}.${method}.\n` +
                `Options: add a .deploy/${method}/ folder, a github.actions.pack-deploy-${method} script, ` +
                `or register a handler via registerDeployMethod('${artifact.type}', '${method}', ...).\n` +
                `Registered methods for '${artifact.type}': ${listDeployMethods(artifact.type).join(', ') || '(none)'}`,
            );
          }
          await handler.copyFiles(deployCtx);
          await handler.generateDeployYml(deployCtx);
        }

        // Validate and inject metadata into deploy.yml
        const deployYmlPath = join(deployOutputDir, 'deploy.yml');
        if (!existsSync(deployYmlPath)) {
          throw new Error(
            `deploy.yml not found in ${deployOutputDir} after running pack-deploy-${method}.\n` +
              `The pack-deploy implementation must produce deploy.yml with at least deployCommand.`,
          );
        }
        const deployMeta = parse(await readFile(deployYmlPath, 'utf-8')) as Record<string, unknown>;
        if (!deployMeta.deployCommand) {
          throw new Error(
            `deploy.yml produced by pack-deploy-${method} is missing required field: deployCommand`,
          );
        }
        // Ensure mode-change fields are present. Built-in handlers already emit
        // method/slot/versioning/teardownCommand; custom .deploy/ folders or
        // pack-deploy scripts may omit them, so fill method/slot/versioning here.
        const slot = deploymentSlot(project.name, project.version, versioning);
        if (!deployMeta.teardownCommand) {
          console.warn(
            `  \u26a0\ufe0f deploy.yml for ${project.name} (${method}) has no teardownCommand \u2014 ` +
              `mode-change teardown will be skipped for this bundle.`,
          );
        }
        await writeFile(
          deployYmlPath,
          stringify({
            ...deployMeta,
            method: deployMeta.method ?? method,
            slot: deployMeta.slot ?? slot,
            versioning: deployMeta.versioning ?? versioning,
            // Presence of `stack` is what switches the deploy side to the
            // versioned `{stack}/{service}/{shared|v{major}}` storage layout.
            ...(deployMeta.stack === undefined && stackOverride !== undefined
              ? { stack: stackOverride }
              : {}),
            // Conditional spread: an absent key must stay absent, since the
            // deploy side rejects a sharedStorage that is present but null.
            ...(deployMeta.sharedStorage === undefined && sharedStorage !== undefined
              ? { sharedStorage }
              : {}),
            ...(deployMeta.seedStorage === undefined && seedStorage !== undefined
              ? { seedStorage }
              : {}),
            name: project.name,
            // Unscoped service segment the deploy side uses for storage paths;
            // must equal the SERVICE token rendered into stack.yml.
            service:
              (deployMeta.service as string | undefined) ??
              serviceOverride ??
              packageService(project.name),
            version: project.version,
            repo: `https://github.com/${process.env.GITHUB_REPOSITORY ?? ''}`,
            releaseId: uploadCtx.releaseId,
          }),
        );

        // Render all text files (including deploy.yml itself) so baked-in values
        // work in YAML keys and anywhere else runtime env interpolation can't reach.
        await renderDeployTemplates(
          deployOutputDir,
          deployContext(project.name, project.version, versioning, stackOverride, serviceOverride),
        );

        // Zip the deploy output dir and upload directly
        const zipName = `deploy-${method}.zip`;
        const zipPath = join(ARTIFACT_OUTPUT_DIR, zipName);
        await mkdir(ARTIFACT_OUTPUT_DIR, { recursive: true });
        await $({ cwd: deployOutputDir })`zip -r ${zipPath} .`;

        await uploadArtifact(
          uploadCtx.githubToken,
          uploadCtx.owner,
          uploadCtx.repo,
          uploadCtx.releaseId,
          uploadCtx.uploadUrl,
          zipPath,
          zipName,
        );
        console.log(`  \u2713 ${project.name}: ${zipName} uploaded`);
      }
    }
    return;
  }

  // ── Legacy path: single github.actions.pack-deploy script ─────────────────
  const packageJson = await readPackageJson(project.cwd);
  if (!packageJson.scripts?.['github.actions.pack-deploy']) {
    return;
  }

  console.log(`\ud83d\ude80 ${project.name}: Running pack-deploy (legacy)...`);

  const env = {
    ...process.env,
    PROJECT_VERSION: project.version,
    PROJECT_NAME: project.name,
    ARTIFACT_OUTPUT_DIR,
    DEPLOY_OUTPUT_DIR: join(project.cwd, '.deploy-output'),
    GITHUB_RELEASE_ID: String(uploadCtx.releaseId),
    GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY ?? '',
    GITHUB_SHA: context.sha,
  } as Record<string, string>;

  await $({ cwd: project.cwd, env })`pnpm run github.actions.pack-deploy`;
  console.log(`\u2713 ${project.name}: pack-deploy completed`);
}

/**
 * Execute upload for a project's artifacts
 * @param project - Project configuration
 * @param context - Workflow context
 * @returns Execution result
 */
export async function executeUpload(
  project: ProjectConfig,
  context: BuildPackContext,
): Promise<ExecutionResult> {
  console.log(`⬆️  ${project.name}: Uploading artifacts...`);

  try {
    const artifactFilename = project.name.replace(/@/g, '').replace(/\//g, '-');
    const artifactPath = join(ARTIFACT_OUTPUT_DIR, `${artifactFilename}.artifact.yml`);

    if (!existsSync(artifactPath)) {
      console.log(`  ⊘ No artifact descriptor found, skipping upload`);
      return {
        project: project.name,
        success: true,
      };
    }

    // Read artifact descriptor
    const artifactYml = await readFile(artifactPath, 'utf-8');
    const doc = parseDocument(artifactYml);
    const descriptor = doc.toJSON() as ProjectArtifactDescriptor;

    console.log(`  📄 Found ${descriptor.artifacts.length} artifact(s) to upload`);

    // Find or create draft release with artifact metadata in body
    const release = await findOrCreateDraftRelease(project, context, artifactYml);

    // Get owner/repo from environment
    const owner = process.env.GITHUB_REPOSITORY_OWNER || 'cpdevtools';
    const repo = process.env.GITHUB_REPOSITORY?.split('/')[1] || 'unknown';

    const uploadCtx: UploadContext = {
      githubToken: context.githubToken,
      owner,
      repo,
      releaseId: release.id,
      uploadUrl: release.upload_url,
      workspaceRoot: context.workspaceRoot,
    };

    // Run pack-deploy (convention-based or legacy) now that we have the release ID
    await executePackDeploy(project, context, descriptor, uploadCtx);

    // Determine if the new convention path was used (deploy: arrays on artifacts)
    type WithDeploy = { deploy?: string[] };
    const hasConventionDeploy = descriptor.artifacts.some(
      (a: Artifact) =>
        Array.isArray((a as unknown as WithDeploy).deploy) &&
        ((a as unknown as WithDeploy).deploy as string[]).length > 0,
    );

    // Re-read descriptor for legacy path — pack-deploy may have updated deploy artifact paths
    const uploadDescriptor = hasConventionDeploy
      ? descriptor
      : (parseDocument(
          await readFile(artifactPath, 'utf-8'),
        ).toJSON() as ProjectArtifactDescriptor);

    for (const artifact of uploadDescriptor.artifacts) {
      // Convention deploy bundles are already uploaded inside executePackDeploy; skip type:deploy entries
      if (artifact.type === 'deploy' && hasConventionDeploy) continue;
      await getArtifactType(artifact.type).upload(artifact, uploadCtx);
    }

    console.log(`✓ ${project.name}: Upload completed`);

    // Mark all artifacts published:true in the release metadata.
    // This is the gate the deploy CLI checks before showing a release as
    // deployable — a release mid-publish has metadata but no published:true,
    // so it won't appear until every asset is uploaded.
    await markReleasePublished(context.githubToken, owner, repo, release.id);

    return {
      project: project.name,
      success: true,
      exitCode: 0,
      releaseUrl: release.html_url,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`✗ ${project.name}: Upload failed - ${errorMessage}`);

    return {
      project: project.name,
      success: false,
      error: errorMessage,
      exitCode: 1,
    };
  }
}

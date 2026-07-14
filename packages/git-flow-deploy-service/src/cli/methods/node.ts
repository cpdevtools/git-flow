import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Returns an env object with the npm global bin directory prepended to PATH */
function withGlobalBinInPath(): NodeJS.ProcessEnv {
  try {
    const globalBin = execSync('npm bin -g 2>/dev/null || npm prefix -g', { encoding: 'utf-8' })
      .trim()
      .replace(/\/lib\/node_modules$/, '/bin')  // npm prefix -g returns prefix, derive bin
      .split('\n')[0];                           // take first line if multiple
    const currentPath = process.env['PATH'] ?? '';
    return { ...process.env, PATH: `${globalBin}:${currentPath}` };
  } catch {
    return process.env;
  }
}

export interface NodeHandlerOptions {
  extractDir: string;
  version: string;
  token: string;
  /** Custom npm prefix (e.g. ~/npm-packages). Omit to use the global npm prefix. */
  npmPrefix?: string;
  /** HMAC secret for webhook validation (DEPLOY_HMAC_SECRET). Required for first-time setup. */
  hmacSecret?: string;
  /** Override service port (default: 3700) */
  port?: string;
  /** Override bind host (default: 0.0.0.0) */
  host?: string;
}

const PACKAGE_NAME = '@cpdevtools/git-flow-deploy-service';
const NPM_REGISTRY = 'https://npm.pkg.github.com';
const PM2_APP_NAME = 'git-flow-deploy-service';

export async function handleNode(options: NodeHandlerOptions): Promise<void> {
  const { extractDir, version, token, npmPrefix, hmacSecret, port, host } = options;

  const isRunning = isPm2AppRunning();

  if (!isRunning) {
    await firstTimeSetup(extractDir, version, token, npmPrefix, hmacSecret, port, host);
  } else {
    await updateExisting(version, token, npmPrefix);
  }
}

async function firstTimeSetup(extractDir: string, version: string, token: string, npmPrefix?: string, hmacSecret?: string, port?: string, host?: string): Promise<void> {
  console.log('First-time setup detected...\n');

  if (!hmacSecret) {
    throw new Error('--hmac-secret is required for first-time setup (used as DEPLOY_HMAC_SECRET)');
  }

  // Ensure pm2 is installed globally
  if (!isPm2Available()) {
    console.log('Installing pm2 globally...');
    execSync('npm install -g pm2', { stdio: 'inherit', env: withGlobalBinInPath() });
  } else {
    console.log('pm2 already installed ✓');
  }

  // Install the service package
  installGlobally(version, token, npmPrefix);

  // Patch ecosystem.config.js: script path + env vars
  const ecoPath = join(extractDir, 'ecosystem.config.js');
  patchEcosystemScript(ecoPath, npmPrefix);
  const envVars: Record<string, string> = {
    DEPLOY_HMAC_SECRET: hmacSecret,
    GITHUB_TOKEN: token,
    ...(port ? { PORT: port } : {}),
    ...(host ? { HOST: host } : {}),
  };
  patchEcosystemEnv(ecoPath, envVars);

  // Start with pm2
  console.log('\nStarting service with pm2...');
  const pathEnv = withGlobalBinInPath();
  execSync(`pm2 start "${ecoPath}" --update-env`, { stdio: 'inherit', env: pathEnv });
  execSync('pm2 save', { stdio: 'inherit', env: pathEnv });

  // Print pm2 startup command for the operator
  printStartupHint();
}

async function updateExisting(version: string, token: string, npmPrefix?: string): Promise<void> {
  console.log('Existing pm2 process detected — running update...\n');

  installGlobally(version, token, npmPrefix);

  console.log('\nReloading pm2 process...');
  const pathEnv = withGlobalBinInPath();
  execSync(`pm2 reload ${PM2_APP_NAME} --update-env`, { stdio: 'inherit', env: pathEnv });
  execSync('pm2 save', { stdio: 'inherit', env: pathEnv });

  console.log(`\n✓ Updated ${PACKAGE_NAME} to v${version}`);
}

function installGlobally(version: string, token: string, npmPrefix?: string): void {
  const destination = npmPrefix ? `prefix: ${npmPrefix}` : 'global';
  console.log(`\nInstalling ${PACKAGE_NAME}@${version} (${destination}) from ${NPM_REGISTRY}...`);

  // Write a scoped .npmrc so only @cpdevtools resolves via GitHub Packages;
  // passing --registry would override the registry for ALL deps (including @nestjs/*)
  const tempDir = mkdtempSync(join(tmpdir(), 'gitflow-install-'));
  const npmrcPath = join(tempDir, '.npmrc');
  writeFileSync(
    npmrcPath,
    `@cpdevtools:registry=${NPM_REGISTRY}\n//${new URL(NPM_REGISTRY).host}/:_authToken=${token}\n`,
  );

  const prefixFlag = npmPrefix ? `--prefix "${npmPrefix}"` : '';
  try {
    execSync(`npm install -g ${prefixFlag} "${PACKAGE_NAME}@${version}"`, {
      stdio: 'inherit',
      env: { ...withGlobalBinInPath(), NPM_CONFIG_USERCONFIG: npmrcPath },
    });
  } finally {
    try { execSync(`rm -f "${npmrcPath}"`, { stdio: 'pipe' }); } catch { /* ignore */ }
  }

  console.log('Install complete ✓');
}

function isPm2AppRunning(): boolean {
  try {
    const env = withGlobalBinInPath();
    const result = spawnSync('pm2', ['list', '--json'], { encoding: 'utf-8', env });
    if (result.status !== 0 || !result.stdout) return false;
    const list = JSON.parse(result.stdout) as Array<{ name: string }>;
    return list.some(app => app.name === PM2_APP_NAME);
  } catch {
    return false;
  }
}

function isPm2Available(): boolean {
  try {
    execSync('pm2 --version', { stdio: 'pipe', env: withGlobalBinInPath() });
    return true;
  } catch {
    return false;
  }
}

function patchEcosystemScript(ecoPath: string, npmPrefix?: string): void {
  if (!existsSync(ecoPath)) {
    console.warn(`Warning: ecosystem.config.js not found at ${ecoPath} — skipping script patch`);
    return;
  }

  // Resolve the install location for dist/main.js
  // Older builds (before tsconfig rootDir fix) put it at dist/src/main.js
  let scriptPath: string;
  try {
    let modulesRoot: string;
    if (npmPrefix) {
      modulesRoot = join(npmPrefix, 'lib', 'node_modules');
    } else {
      modulesRoot = execSync('npm root -g', { encoding: 'utf-8' }).trim();
    }
    const primary = join(modulesRoot, PACKAGE_NAME, 'dist', 'main.js');
    const fallback = join(modulesRoot, PACKAGE_NAME, 'dist', 'src', 'main.js');
    scriptPath = existsSync(primary) ? primary : fallback;
  } catch {
    console.warn('Warning: could not resolve install root — ecosystem script path may be incorrect');
    return;
  }

  let content = readFileSync(ecoPath, 'utf-8');
  const patched = content.replace(
    /script:\s*['"][^'"]*dist\/main\.js['"]/g,
    `script: '${scriptPath}'`,
  );

  if (patched === content) {
    console.warn('Warning: could not find "script: …dist/main.js" in ecosystem.config.js to patch');
  } else {
    writeFileSync(ecoPath, patched);
    console.log(`Patched ecosystem.config.js: script → ${scriptPath}`);
  }
}

function patchEcosystemEnv(ecoPath: string, vars: Record<string, string>): void {
  if (!existsSync(ecoPath)) return;

  let content = readFileSync(ecoPath, 'utf-8');

  for (const [key, value] of Object.entries(vars)) {
    const escaped = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    // Replace existing key if present
    const existing = new RegExp(`(\\s+)${key}:\\s*['"][^'"]*['"]`, 'g');
    if (existing.test(content)) {
      content = content.replace(existing, `$1${key}: '${escaped}'`);
    } else {
      // Inject after NODE_ENV line
      content = content.replace(
        /(NODE_ENV:\s*['"]production['"])/,
        `$1,\n        ${key}: '${escaped}'`,
      );
    }
  }

  writeFileSync(ecoPath, content);
  console.log(`Patched ecosystem.config.js: env vars → ${Object.keys(vars).join(', ')}`);
}

function printStartupHint(): void {  console.log('\n' + '─'.repeat(70));
  console.log('⚡ To configure pm2 to start on system boot, run:');
  console.log('');
  console.log('   pm2 startup');
  console.log('');
  console.log('   Then copy and run the command it prints (requires root/sudo).');
  console.log('─'.repeat(70) + '\n');
}

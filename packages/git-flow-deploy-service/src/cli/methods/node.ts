import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface NodeHandlerOptions {
  extractDir: string;
  version: string;
  token: string;
}

const PACKAGE_NAME = '@cpdevtools/git-flow-deploy-service';
const NPM_REGISTRY = 'https://npm.pkg.github.com';
const PM2_APP_NAME = 'git-flow-deploy-service';

export async function handleNode(options: NodeHandlerOptions): Promise<void> {
  const { extractDir, version, token } = options;

  const isRunning = isPm2AppRunning();

  if (!isRunning) {
    await firstTimeSetup(extractDir, version, token);
  } else {
    await updateExisting(version, token);
  }
}

async function firstTimeSetup(extractDir: string, version: string, token: string): Promise<void> {
  console.log('First-time setup detected...\n');

  // Ensure pm2 is installed globally
  if (!isPm2Available()) {
    console.log('Installing pm2 globally...');
    execSync('npm install -g pm2', { stdio: 'inherit' });
  } else {
    console.log('pm2 already installed ✓');
  }

  // Install the service package globally
  installGlobally(version, token);

  // Patch ecosystem.config.js script path to the resolved global install location
  const ecoPath = join(extractDir, 'ecosystem.config.js');
  patchEcosystemScript(ecoPath);

  // Start with pm2
  console.log('\nStarting service with pm2...');
  execSync(`pm2 start "${ecoPath}" --update-env`, { stdio: 'inherit' });
  execSync('pm2 save', { stdio: 'inherit' });

  // Print pm2 startup command for the operator
  printStartupHint();
}

async function updateExisting(version: string, token: string): Promise<void> {
  console.log('Existing pm2 process detected — running update...\n');

  installGlobally(version, token);

  console.log('\nReloading pm2 process...');
  execSync(`pm2 reload ${PM2_APP_NAME} --update-env`, { stdio: 'inherit' });
  execSync('pm2 save', { stdio: 'inherit' });

  console.log(`\n✓ Updated ${PACKAGE_NAME} to v${version}`);
}

function installGlobally(version: string, token: string): void {
  console.log(`\nInstalling ${PACKAGE_NAME}@${version} globally from ${NPM_REGISTRY}...`);

  // Write a scoped .npmrc so only @cpdevtools resolves via GitHub Packages;
  // passing --registry would override the registry for ALL deps (including @nestjs/*)
  const tempDir = mkdtempSync(join(tmpdir(), 'gitflow-install-'));
  const npmrcPath = join(tempDir, '.npmrc');
  writeFileSync(
    npmrcPath,
    `@cpdevtools:registry=${NPM_REGISTRY}\n//${new URL(NPM_REGISTRY).host}/:_authToken=${token}\n`,
  );

  try {
    execSync(`npm install -g "${PACKAGE_NAME}@${version}"`, {
      stdio: 'inherit',
      env: { ...process.env, NPM_CONFIG_USERCONFIG: npmrcPath },
    });
  } finally {
    // temp dir is small — OS will clean it up, but remove npmrc immediately for security
    try { execSync(`rm -f "${npmrcPath}"`, { stdio: 'pipe' }); } catch { /* ignore */ }
  }

  console.log('Global install complete ✓');
}

function isPm2AppRunning(): boolean {
  try {
    const result = spawnSync('pm2', ['list', '--json'], { encoding: 'utf-8' });
    if (result.status !== 0 || !result.stdout) return false;
    const list = JSON.parse(result.stdout) as Array<{ name: string }>;
    return list.some(app => app.name === PM2_APP_NAME);
  } catch {
    return false;
  }
}

function isPm2Available(): boolean {
  try {
    execSync('pm2 --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function patchEcosystemScript(ecoPath: string): void {
  if (!existsSync(ecoPath)) {
    console.warn(`Warning: ecosystem.config.js not found at ${ecoPath} — skipping script patch`);
    return;
  }

  // Resolve the absolute path of the globally installed dist/main.js
  let scriptPath: string;
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf-8' }).trim();
    scriptPath = join(globalRoot, PACKAGE_NAME, 'dist', 'main.js');
  } catch {
    console.warn('Warning: could not resolve npm global root — ecosystem script path may be incorrect');
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

function printStartupHint(): void {
  console.log('\n' + '─'.repeat(70));
  console.log('⚡ To configure pm2 to start on system boot, run:');
  console.log('');
  console.log('   pm2 startup');
  console.log('');
  console.log('   Then copy and run the command it prints (requires root/sudo).');
  console.log('─'.repeat(70) + '\n');
}

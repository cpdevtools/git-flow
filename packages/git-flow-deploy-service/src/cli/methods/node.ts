import { execSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

/**
 * Default npm prefix for global installs when --npm-prefix is not provided.
 * Home-based so installs work as a non-root user without writing to system
 * directories (e.g. the nvm-managed global node_modules).
 */
function defaultNpmPrefix(): string {
  return join(homedir(), '.npm-global');
}

/**
 * Returns an env object with the given prefix's bin directory (and the npm
 * global bin directory as a fallback) prepended to PATH, so binaries installed
 * under a custom prefix (pm2, the service) are discoverable.
 */
function withGlobalBinInPath(prefix: string): NodeJS.ProcessEnv {
  const bins = [join(prefix, 'bin')];
  try {
    const globalBin = join(
      execSync('npm prefix -g', { encoding: 'utf-8' }).trim(),
      'bin',
    );
    if (globalBin !== bins[0]) bins.push(globalBin);
  } catch {
    // npm prefix -g may fail in minimal environments — the custom prefix bin is enough
  }
  const currentPath = process.env['PATH'] ?? '';
  return {
    ...process.env,
    PATH: [...bins, currentPath].filter(Boolean).join(':'),
  };
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
  /**
   * When true, configure pm2 to resurrect the service on system boot. This runs
   * a single privileged (sudo) `pm2 startup` step; the service itself keeps
   * running as the current unprivileged user.
   */
  enableBoot?: boolean;
}

const PACKAGE_NAME = '@cpdevtools/git-flow-deploy-service';
const NPM_REGISTRY = 'https://npm.pkg.github.com';
const PM2_APP_NAME = 'git-flow-deploy-service';

/**
 * Absolute path to the pm2 binary under the given prefix, falling back to a
 * PATH-resolved `pm2` when it isn't installed under the prefix. Using the
 * absolute path means the service lifecycle never depends on the host having
 * the prefix's bin directory on PATH.
 */
function pm2Bin(prefix: string): string {
  const local = join(prefix, 'bin', 'pm2');
  return existsSync(local) ? local : 'pm2';
}

export async function handleNode(options: NodeHandlerOptions): Promise<void> {
  const {
    extractDir,
    version,
    token,
    npmPrefix,
    hmacSecret,
    port,
    host,
    enableBoot,
  } = options;

  // Resolve the npm prefix once (defaults to a home-based, user-writable prefix)
  // and ensure it exists so every global install below targets the same location.
  const prefix = npmPrefix ?? defaultNpmPrefix();
  mkdirSync(prefix, { recursive: true });

  const isRunning = isPm2AppRunning(prefix);

  if (!isRunning) {
    await firstTimeSetup(
      extractDir,
      version,
      token,
      prefix,
      hmacSecret,
      port,
      host,
      enableBoot,
    );
  } else {
    await updateExisting(
      extractDir,
      version,
      token,
      prefix,
      port,
      host,
      enableBoot,
    );
  }
}

async function firstTimeSetup(
  extractDir: string,
  version: string,
  token: string,
  npmPrefix: string,
  hmacSecret?: string,
  port?: string,
  host?: string,
  enableBoot?: boolean,
): Promise<void> {
  console.log('First-time setup detected...\n');

  if (!hmacSecret) {
    throw new Error(
      '--hmac-secret is required for first-time setup (used as DEPLOY_HMAC_SECRET)',
    );
  }

  // Ensure pm2 is installed under the same (writable) prefix as the service
  if (!isPm2Available(npmPrefix)) {
    console.log(`Installing pm2 (prefix: ${npmPrefix})...`);
    execSync(`npm install -g --prefix "${npmPrefix}" pm2`, {
      stdio: 'inherit',
      env: withGlobalBinInPath(npmPrefix),
    });
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
    GITFLOW_NPM_PREFIX: npmPrefix,
    ...(port ? { PORT: port } : {}),
    ...(host ? { HOST: host } : {}),
  };
  patchEcosystemEnv(ecoPath, envVars);

  // Start with pm2 (absolute path so this never depends on PATH configuration)
  console.log('\nStarting service with pm2...');
  const pm2 = pm2Bin(npmPrefix);
  const pathEnv = withGlobalBinInPath(npmPrefix);
  execSync(`"${pm2}" start "${ecoPath}" --update-env`, {
    stdio: 'inherit',
    env: pathEnv,
  });
  execSync(`"${pm2}" save`, { stdio: 'inherit', env: pathEnv });

  // Configure boot persistence for the operator when opted in, otherwise just
  // print the one privileged command they can run themselves.
  if (enableBoot) {
    configureBootStartup(pm2, npmPrefix);
  } else {
    printStartupHint(pm2);
  }
}

async function updateExisting(
  extractDir: string,
  version: string,
  token: string,
  npmPrefix: string,
  port?: string,
  host?: string,
  enableBoot?: boolean,
): Promise<void> {
  console.log('Existing pm2 process detected — running update...\n');

  installGlobally(version, token, npmPrefix);

  // Re-patch env vars in ecosystem.config.js (port/host may have changed).
  // Also carry forward any operator-set vars (DEPLOY_WORK_DIR, COMPOSE_FILE,
  // DEPLOY_HOST_ROOT, etc.) that the CLI doesn't manage — the ecosystem file
  // from the new bundle starts fresh, so without this they'd be wiped when pm2
  // restarts from the file with --update-env.
  const ecoPath = join(extractDir, 'ecosystem.config.js');
  const currentPm2Env = getCurrentPm2Env(npmPrefix);
  const envVars: Record<string, string> = {
    ...currentPm2Env,
    GITHUB_TOKEN: token,
    GITFLOW_NPM_PREFIX: npmPrefix,
    ...(port ? { PORT: port } : {}),
    ...(host ? { HOST: host } : {}),
  };
  patchEcosystemEnv(ecoPath, envVars);

  // Reload via ecosystem file path so pm2 picks up updated env vars
  // (absolute pm2 path so this never depends on PATH configuration)
  console.log('\nReloading pm2 process...');
  const pm2 = pm2Bin(npmPrefix);
  const pathEnv = withGlobalBinInPath(npmPrefix);
  execSync(`"${pm2}" restart "${ecoPath}" --update-env`, {
    stdio: 'inherit',
    env: pathEnv,
  });
  execSync(`"${pm2}" save`, { stdio: 'inherit', env: pathEnv });

  if (enableBoot) {
    configureBootStartup(pm2, npmPrefix);
  }

  console.log(`\n✓ Updated ${PACKAGE_NAME} to v${version}`);
}

function installGlobally(
  version: string,
  token: string,
  npmPrefix: string,
): void {
  console.log(
    `\nInstalling ${PACKAGE_NAME}@${version} (prefix: ${npmPrefix}) from ${NPM_REGISTRY}...`,
  );

  // Write a scoped .npmrc so only @cpdevtools resolves via GitHub Packages;
  // passing --registry would override the registry for ALL deps (including @nestjs/*)
  const tempDir = mkdtempSync(join(tmpdir(), 'gitflow-install-'));
  const npmrcPath = join(tempDir, '.npmrc');
  writeFileSync(
    npmrcPath,
    `@cpdevtools:registry=${NPM_REGISTRY}\n//${new URL(NPM_REGISTRY).host}/:_authToken=${token}\n`,
  );

  try {
    execSync(
      `npm install -g --prefix "${npmPrefix}" "${PACKAGE_NAME}@${version}"`,
      {
        stdio: 'inherit',
        env: {
          ...withGlobalBinInPath(npmPrefix),
          NPM_CONFIG_USERCONFIG: npmrcPath,
        },
      },
    );
  } finally {
    try {
      execSync(`rm -f "${npmrcPath}"`, { stdio: 'pipe' });
    } catch {
      /* ignore */
    }
  }

  console.log('Install complete ✓');
}

function isPm2AppRunning(prefix: string): boolean {
  try {
    const env = withGlobalBinInPath(prefix);
    // pm2 describe exits 0 if the app is known to pm2, non-zero if not
    const result = spawnSync(pm2Bin(prefix), ['describe', PM2_APP_NAME], {
      encoding: 'utf-8',
      env,
    });
    return result.status === 0 && result.stdout.includes(PM2_APP_NAME);
  } catch {
    return false;
  }
}

/**
 * Read the current pm2 env for our app (best-effort). Returns the vars the
 * operator set on the running process (e.g. DEPLOY_WORK_DIR, COMPOSE_FILE) so
 * they can be preserved when the ecosystem file is patched and the process is
 * restarted. Returns an empty object when the process isn't running or pm2 is
 * unavailable.
 */
function getCurrentPm2Env(prefix: string): Record<string, string> {
  try {
    const env = withGlobalBinInPath(prefix);
    const result = spawnSync(pm2Bin(prefix), ['jlist'], {
      encoding: 'utf-8',
      env,
    });
    if (result.status !== 0 || !result.stdout) return {};
    const list = JSON.parse(result.stdout) as Array<{
      name: string;
      pm2_env?: Record<string, unknown>;
    }>;
    const app = list.find((p) => p.name === PM2_APP_NAME);
    if (!app?.pm2_env) return {};
    // Only forward vars that look like operator-set deployment config.
    // Skip pm2 internals (pm_*), NODE_*, PATH etc.
    const skip = new Set([
      'NODE_ENV',
      'PORT',
      'HOST',
      'GITHUB_TOKEN',
      'GITFLOW_NPM_PREFIX',
      'NODE_VERSION',
      'NODE_PATH',
      'PATH',
      'HOME',
      'SHELL',
      'USER',
      'LOGNAME',
      'PWD',
      'OLDPWD',
      'SHLVL',
      '_',
    ]);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(app.pm2_env)) {
      if (
        k.startsWith('pm_') ||
        k.startsWith('PM2_') ||
        skip.has(k) ||
        typeof v !== 'string'
      )
        continue;
      out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function isPm2Available(prefix: string): boolean {
  try {
    execSync(`"${pm2Bin(prefix)}" --version`, {
      stdio: 'pipe',
      env: withGlobalBinInPath(prefix),
    });
    return true;
  } catch {
    return false;
  }
}

function patchEcosystemScript(ecoPath: string, npmPrefix?: string): void {
  if (!existsSync(ecoPath)) {
    console.warn(
      `Warning: ecosystem.config.js not found at ${ecoPath} — skipping script patch`,
    );
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
    console.warn(
      'Warning: could not resolve install root — ecosystem script path may be incorrect',
    );
    return;
  }

  let content = readFileSync(ecoPath, 'utf-8');

  // Already patched to the correct absolute path — nothing to do
  if (
    content.includes(`'${scriptPath}'`) ||
    content.includes(`"${scriptPath}"`)
  ) {
    console.log('ecosystem.config.js script already correct ✓');
    return;
  }

  // Match relative dist/main.js or dist/src/main.js (pre-tsconfig-fix builds)
  const patched = content.replace(
    /script:\s*['"][^'"]*dist\/(?:src\/)?main\.js['"]/g,
    `script: '${scriptPath}'`,
  );

  if (patched === content) {
    console.warn(
      'Warning: could not find script path in ecosystem.config.js to patch',
    );
  } else {
    writeFileSync(ecoPath, patched);
    console.log(`Patched ecosystem.config.js: script → ${scriptPath}`);
  }
}

function patchEcosystemEnv(
  ecoPath: string,
  vars: Record<string, string>,
): void {
  if (!existsSync(ecoPath)) return;

  let content = readFileSync(ecoPath, 'utf-8');

  for (const [key, value] of Object.entries(vars)) {
    const escaped = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    // Match existing key with either a quoted string or a bare number value
    const existing = new RegExp(
      `([ \\t]+)${key}:\\s*(?:'[^']*'|"[^"]*"|\\d+)`,
      'g',
    );
    if (existing.test(content)) {
      content = content.replace(
        new RegExp(`([ \\t]+)${key}:\\s*(?:'[^']*'|"[^"]*"|\\d+)`, 'g'),
        `$1${key}: '${escaped}'`,
      );
    } else {
      // Inject after NODE_ENV line
      content = content.replace(
        /(NODE_ENV:\s*['"]production['"])/,
        `$1,\n        ${key}: '${escaped}'`,
      );
    }
  }

  writeFileSync(ecoPath, content);
  console.log(
    `Patched ecosystem.config.js: env vars → ${Object.keys(vars).join(', ')}`,
  );
}

function printStartupHint(pm2: string): void {
  console.log('\n' + '─'.repeat(70));
  console.log('⚡ To configure pm2 to start on system boot, run:');
  console.log('');
  console.log(`   ${pm2} startup`);
  console.log('');
  console.log(
    '   Then copy and run the command it prints (requires root/sudo).',
  );
  console.log('─'.repeat(70) + '\n');
}

/**
 * Configures pm2 to resurrect the service on system boot. This is the ONLY step
 * that needs elevated privileges (writing a systemd/init unit), so it is run
 * with sudo while the service itself keeps running as the current, unprivileged
 * user. The generated unit runs `pm2 resurrect` as that user — the service
 * never runs as root.
 */
function configureBootStartup(pm2: string, npmPrefix: string): void {
  const { username } = userInfo();
  const home = homedir();
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const sudo = isRoot ? '' : 'sudo ';
  // env PATH="$PATH" bakes the current PATH (incl. node + the prefix bin) into
  // the generated boot unit so `pm2 resurrect` can find node at boot time.
  const cmd = `${sudo}env PATH="$PATH" "${pm2}" startup -u "${username}" --hp "${home}"`;

  console.log('\nConfiguring pm2 to start on system boot...');
  if (!isRoot) console.log('  (sudo may prompt for your password)');
  try {
    execSync(cmd, { stdio: 'inherit', env: withGlobalBinInPath(npmPrefix) });
    console.log(
      '✓ Boot startup configured — the service will resurrect on reboot.',
    );
  } catch {
    console.warn(
      '⚠ Could not configure boot startup automatically. Run this manually:',
    );
    console.warn(`   ${cmd}`);
  }
}

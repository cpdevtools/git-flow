/**
 * pnpm hook to conditionally use local packages when DEV_LOCAL=true
 * This allows development against local package sources instead of published npm packages
 *
 * Usage:
 *   DEV_LOCAL=true pnpm install  # Uses local packages via file: protocol (if they exist)
 *   pnpm install                 # Uses published npm packages
 *
 * Note: We use file: protocol with absolute paths to avoid path resolution issues
 * when packages are in different subdirectories of the workspace.
 */

const fs = require('fs');
const path = require('path');

// Track if we've already logged the initial message and warnings
let hasLoggedInit = false;
const warnedPackages = new Set();
const checkedPackages = new Map(); // Cache existence checks

function readPackage(pkg, context) {
  if (process.env.DEV_LOCAL === 'true') {
    // Map of npm package names to their local paths (relative to workspace root)
    const localPackagesConfig = {
      '@cpdevtools/ts-dev-utilities': '../ts-dev-utilities',
      '@cpdevtools/git-flow': './packages/git-flow',
    };

    if (!hasLoggedInit) {
      console.log('DEV_LOCAL=true detected - checking for local packages...');
      hasLoggedInit = true;
    }

    // Check which packages actually exist (only check once and cache the results)
    Object.entries(localPackagesConfig).forEach(([pkgName, relativePath]) => {
      if (!checkedPackages.has(pkgName)) {
        const absolutePath = path.resolve(__dirname, relativePath);
        const packageJsonPath = path.join(absolutePath, 'package.json');

        if (fs.existsSync(packageJsonPath)) {
          // Use file: protocol with absolute path to avoid relative path issues
          checkedPackages.set(pkgName, `file:${absolutePath}`);
        } else {
          checkedPackages.set(pkgName, null);
          if (!warnedPackages.has(pkgName)) {
            console.log(`  ⚠️  Skipping ${pkgName}: local path not found (${relativePath})`);
            warnedPackages.add(pkgName);
          }
        }
      }
    });

    // Override in dependencies, devDependencies, and peerDependencies
    ['dependencies', 'devDependencies', 'peerDependencies'].forEach((depType) => {
      if (pkg[depType]) {
        checkedPackages.forEach((fileUrl, pkgName) => {
          if (fileUrl && pkg[depType][pkgName]) {
            pkg[depType][pkgName] = fileUrl;
          }
        });
      }
    });
  } else {
    // Strip file: protocol dependencies — they are local-only and must not appear in CI lockfiles
    ['dependencies', 'devDependencies', 'peerDependencies'].forEach((depType) => {
      if (pkg[depType]) {
        for (const [name, version] of Object.entries(pkg[depType])) {
          if (typeof version === 'string' && version.startsWith('file:')) {
            delete pkg[depType][name];
          }
        }
      }
    });
  }

  return pkg;
}

// Always export hooks so pnpm consistently hashes the pnpmfile and the
// file: stripping logic applies whether DEV_LOCAL is set or not.
module.exports = {
  hooks: {
    readPackage,
  },
};

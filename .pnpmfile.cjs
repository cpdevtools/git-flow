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
  // Apply overrides to ALL packages (not just root) when DEV_LOCAL=true
  if (process.env.DEV_LOCAL === 'true') {
    // Map of npm package names to their local paths (relative to workspace root)
    const localPackagesConfig = {
      '@cpdevtools/ts-dev-utilities': '../ts-dev-utilities',
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
  }

  return pkg;
}

// Only export hooks when DEV_LOCAL=true to avoid lockfile checksum mismatch in CI
if (process.env.DEV_LOCAL === 'true') {
  module.exports = {
    hooks: {
      readPackage,
    },
  };
} else {
  module.exports = {
    hooks: {},
  };
}

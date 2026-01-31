import { defineConfig } from 'tsup';
import { builtinModules } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  sourcemap: false,
  clean: true,
  bundle: true,
  minify: false,
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  noExternal: [/.*/],
  external: [...builtinModules.map(m => `node:${m}`)],
  shims: true,
  async onSuccess() {
    // Post-process to add node: prefix to all bare built-in imports
    const distFile = 'dist/index.js';
    let content = await readFile(distFile, 'utf-8');
    
    const builtins = ['path', 'fs', 'url', 'crypto', 'stream', 'util', 'events', 'http', 'https', 'zlib', 'buffer', 'querystring', 'os', 'child_process', 'net', 'tls', 'dns', 'dgram', 'readline', 'process'];
    for (const builtin of builtins) {
      // Replace all variations: from "builtin", from 'builtin'
      content = content.replace(new RegExp(`from ["']${builtin}["']`, 'g'), `from "node:${builtin}"`);
    }
    
    await writeFile(distFile, content, 'utf-8');
    console.log('✓ Added node: prefix to all built-in module imports');
  },
  banner: {
    js: `import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);`,
  },
});

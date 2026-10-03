// Ship the shell assets generateDeployYml reads verbatim at runtime next to the
// built module, so __dirname resolves them in dist too. A script file rather
// than `node -e`: tsup rewrites path separators inside an onSuccess command on
// Windows, which turned the inline version into a syntax error.
const { cpSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
mkdirSync(join(root, 'dist', 'artifacts'), { recursive: true });
for (const file of ['restart.sh', 'gh-pages-deploy.sh']) {
  cpSync(join(root, 'src', 'artifacts', file), join(root, 'dist', 'artifacts', file));
}

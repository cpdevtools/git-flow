const { writeArtifact } = require('../lib/artifacts');
const { readFileSync } = require('fs');
const { join } = require('path');

async function generateArtifact() {
  const packageJsonPath = join(process.cwd(), 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  
  // Get artifact output directory from environment or use default
  const artifactOutputDir = process.env.ARTIFACT_OUTPUT_DIR || '.artifacts';
  const tarballName = `${packageJson.name.replace('@', '').replace('/', '-')}-${packageJson.version}.tgz`;
  
  console.log(`Generating artifact descriptor for ${packageJson.name}@${packageJson.version}`);
  console.log(`Artifact output directory: ${artifactOutputDir}`);
  console.log(`Tarball name: ${tarballName}`);
  
  // Set PROJECT_NAME environment variable that writeArtifact expects
  process.env.PROJECT_NAME = packageJson.name;
  
  // Create the artifact descriptor in the workspace root
  const rootPath = join(process.cwd(), '../..');
  
  await writeArtifact({
    project: packageJson.name,
    version: packageJson.version,
    artifacts: [{
      type: 'npm',
      name: packageJson.name,
      version: packageJson.version,
      path: join(artifactOutputDir, tarballName),
      registries: ['github-npm']
    }]
  }, rootPath);
  
  console.log('✅ Artifact descriptor generated');
}

generateArtifact().catch(console.error);
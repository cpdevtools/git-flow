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
  
  // Set environment variables that writeArtifact expects
  // PROJECT_NAME is used as the filename (converted: @cpdevtools/git-flow -> cpdevtools-git-flow)
  const artifactFilename = packageJson.name.replace(/@/g, '').replace(/\//g, '-');
  process.env.PROJECT_NAME = artifactFilename;
  
  // ARTIFACT_OUTPUT_DIR should already be set by the workflow, but default to workspace root
  if (!process.env.ARTIFACT_OUTPUT_DIR) {
    process.env.ARTIFACT_OUTPUT_DIR = join(process.cwd(), '../..', artifactOutputDir);
  }
  
  await writeArtifact({
    project: packageJson.name,
    artifacts: [
      {
        type: 'npm',
        name: packageJson.name,
        path: `packages/git-flow/${tarballName}`,
        registries: ['github-packages']
      }
    ]
  });
  
  console.log('✅ Artifact descriptor generated');
}

generateArtifact().catch(console.error);
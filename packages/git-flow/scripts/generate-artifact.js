const { writeArtifact } = require('@cpdevtools/ts-dev-utilities/artifacts');
const { readFileSync, mkdirSync, copyFileSync } = require('fs');
const { join } = require('path');

async function generateArtifact() {
  const packageJsonPath = join(process.cwd(), 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  
  const tarballName = `${packageJson.name.replace('@', '').replace('/', '-')}-${packageJson.version}.tgz`;
  
  console.log(`Generating artifact descriptor for ${packageJson.name}@${packageJson.version}`);
  console.log(`Artifact output directory: ${process.env.ARTIFACT_OUTPUT_DIR || '.artifacts'}`);
  console.log(`Tarball name: ${tarballName}`);
  
  // Set environment variables that writeArtifact expects
  // PROJECT_NAME is used as the filename (converted: @cpdevtools/git-flow -> cpdevtools-git-flow)
  const artifactFilename = packageJson.name.replace(/@/g, '').replace(/\//g, '-');
  process.env.PROJECT_NAME = artifactFilename;
  
  // ARTIFACT_OUTPUT_DIR should already be set by the workflow
  // If not (e.g., running locally), default to workspace root
  const artifactOutputDir = process.env.ARTIFACT_OUTPUT_DIR || join(process.cwd(), '../..', '.artifacts');
  
  // Copy the tarball to .artifacts directory before git checkout restores files
  const tarballSource = join(process.cwd(), tarballName);
  const tarballDest = join(artifactOutputDir, tarballName);
  mkdirSync(artifactOutputDir, { recursive: true });
  copyFileSync(tarballSource, tarballDest);
  console.log(`✓ Copied tarball to ${tarballDest}`);
  
  await writeArtifact({
    project: packageJson.name,
    artifacts: [
      {
        type: 'npm',
        name: packageJson.name,
        path: `.artifacts/${tarballName}`,
        registries: ['github-packages']
      }
    ]
  });
  
  console.log('✅ Artifact descriptor generated');
}

generateArtifact().catch(console.error);
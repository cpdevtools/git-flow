const { readFileSync, writeFileSync, mkdirSync } = require('fs');
const { join, dirname } = require('path');
const { stringify } = require('yaml');

/**
 * Inline version of writeArtifact from @cpdevtools/ts-dev-utilities
 * TODO: Replace with actual package import once published
 */
function writeArtifact(descriptor) {
  const artifactOutputDir = process.env.ARTIFACT_OUTPUT_DIR;
  const projectName = process.env.PROJECT_NAME;

  if (!artifactOutputDir) {
    throw new Error(
      'ARTIFACT_OUTPUT_DIR environment variable is required. ' +
      'This should be set by the workflow.'
    );
  }

  if (!projectName) {
    throw new Error(
      'PROJECT_NAME environment variable is required. ' +
      'This should be set by the workflow.'
    );
  }

  const artifactPath = join(artifactOutputDir, `${projectName}.artifact.yml`);

  // Ensure output directory exists
  mkdirSync(dirname(artifactPath), { recursive: true });

  // Write YAML file
  const yamlContent = stringify(descriptor, {
    indent: 2,
    lineWidth: 0, // Don't wrap lines
  });

  writeFileSync(artifactPath, yamlContent, 'utf-8');

  console.log(`✓ Generated artifact descriptor: ${artifactPath}`);
}

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
  if (!process.env.ARTIFACT_OUTPUT_DIR) {
    process.env.ARTIFACT_OUTPUT_DIR = join(process.cwd(), '../..', '.artifacts');
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
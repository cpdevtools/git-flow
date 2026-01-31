import { writeArtifact } from '@cpdevtools/ts-dev-utilities/artifacts';
import { readFileSync } from 'fs';
import { join } from 'path';

async function generateArtifact() {
  const packageJsonPath = join(process.cwd(), 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  
  // Get artifact output directory from environment or use default
  const artifactOutputDir = process.env.ARTIFACT_OUTPUT_DIR || '.artifacts';
  const tarballName = `${packageJson.name.replace('@', '').replace('/', '-')}-${packageJson.version}.tgz`;
  
  console.log(`Generating artifact descriptor for ${packageJson.name}@${packageJson.version}`);
  console.log(`Artifact output directory: ${artifactOutputDir}`);
  console.log(`Tarball name: ${tarballName}`);
  
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
  });
  
  console.log('✅ Artifact descriptor generated');
}

generateArtifact().catch(console.error);
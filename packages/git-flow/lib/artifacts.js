const { writeFileSync } = require('fs');
const path = require('path');
const yaml = require('yaml');

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

  // Ensure the directory exists
  const fs = require('fs');
  if (!fs.existsSync(artifactOutputDir)) {
    fs.mkdirSync(artifactOutputDir, { recursive: true });
  }

  const filename = `${projectName}.artifact.yml`;
  const filePath = path.join(artifactOutputDir, filename);

  // Write YAML file using yaml library for proper formatting
  const yamlContent = yaml.stringify(descriptor, {
    indent: 2,
    lineWidth: 0, // Don't wrap lines
  });

  writeFileSync(filePath, yamlContent, 'utf-8');

  console.log(`✓ Generated artifact descriptor: ${filePath}`);
  
  return {
    path: filePath,
    content: descriptor
  };
}

module.exports = {
  writeArtifact
};
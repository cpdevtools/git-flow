const { writeFileSync } = require('fs');
const path = require('path');

function writeArtifact(descriptor) {
  // Get the workspace root directory (two levels up from packages/git-flow)
  const workspaceRoot = path.resolve(__dirname, '../../../');
  
  // Default output directory
  const artifactOutputDir = process.env.ARTIFACT_OUTPUT_DIR || '.artifacts';
  const outputPath = path.join(workspaceRoot, artifactOutputDir);
  
  // Ensure the directory exists
  const fs = require('fs');
  if (!fs.existsSync(outputPath)) {
    fs.mkdirSync(outputPath, { recursive: true });
  }
  
  // Use project name as filename with .artifact.yml extension
  const projectName = process.env.PROJECT_NAME || 'unknown';
  const filename = `${projectName.replace('@', '').replace('/', '-')}.artifact.yml`;
  const filePath = path.join(outputPath, filename);
  
  // Convert descriptor to YAML format (simple implementation)
  const yamlContent = `---
name: "${descriptor.name || projectName}"
version: "${descriptor.version || '0.0.0'}"
type: "${descriptor.type || 'package'}"
path: "${descriptor.path || '.'}"
tempTag: "${descriptor.tempTag || ''}"
finalTag: "${descriptor.finalTag || ''}"
digest: "${descriptor.digest || ''}"
`;
  
  // Write the descriptor as YAML
  writeFileSync(filePath, yamlContent);
  
  console.log(`✓ Artifact descriptor written to ${filePath}`);
  
  return {
    path: filePath,
    content: descriptor
  };
}

module.exports = {
  writeArtifact
};
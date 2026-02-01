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
  
  // Use project name as filename
  const projectName = process.env.PROJECT_NAME || 'unknown';
  const filename = `${projectName.replace('@', '').replace('/', '-')}.json`;
  const filePath = path.join(outputPath, filename);
  
  // Write the descriptor
  writeFileSync(filePath, JSON.stringify(descriptor, null, 2));
  
  console.log(`✓ Artifact descriptor written to ${filePath}`);
  
  return {
    path: filePath,
    content: descriptor
  };
}

module.exports = {
  writeArtifact
};
export interface ProjectArtifactDescriptor {
  /** Project name */
  name: string;
  /** Project version */
  version: string;
  /** File path relative to artifact output directory */
  path: string;
  /** MIME type */
  mimeType: string;
  /** File size in bytes */
  size: number;
  /** SHA256 hash */
  sha256: string;
  /** Array of artifacts for this project */
  artifacts: Artifact[];
}

export interface Artifact {
  /** Artifact file path */
  path: string;
  /** Artifact content */
  content?: Buffer | string;
  /** Metadata */
  metadata?: Record<string, any>;
}
import type { Project } from '../lib/project.js';

export type TestMode = 'build' | 'test' | 'test-optional';
export type TagType = 'build' | 'test';

export interface TestOptions {
  workspaceRoot: string;
  branch: string;
  mode: TestMode;
  skipUnchanged: boolean;
  rerunAll: boolean;
  token: string;
}

export interface TestContext extends TestOptions {
  currentSHA: string;
  failedProjects: Set<string>;
}

export interface TestResult {
  project: Project;
  success: boolean;
  duration: number;
  reason?: 'failed' | 'dependency-failed' | 'unchanged' | 'no-scripts';
  error?: Error;
  output?: string;
}

export interface TestSummary {
  passed: TestResult[];
  failed: TestResult[];
  skipped: TestResult[];
  unchanged: TestResult[];
}

export interface LastPassTag {
  tag: string;
  sha: string;
  source: 'current-branch' | 'none';
}

export interface ChangeDetectionOptions {
  workspaceRoot: string;
  project: Project;
  branch: string;
  tagType: TagType;
}

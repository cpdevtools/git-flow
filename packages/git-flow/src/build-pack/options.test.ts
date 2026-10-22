import { describe, expect, it } from 'vitest';
import { extractPRMetadata, setReleaseIdsInPRBody } from './options.js';

const body = `## Release from \`main\`

### Metadata

\`\`\`yaml
MAIN:
  tags:
    - MAIN/v1.0.0-rc.0
    - v1.0.0-rc.0
  projects:
    - name: @idealsupply/cxml-connection-test
      version: 1.0.0-rc.0
      prerelease: true
      cwd: .
      tags:
        - @idealsupply/cxml-connection-test/v1.0.0-rc.0
    - name: @idealsupply/other
      version: 1.0.0-rc.0
      prerelease: true
      cwd: packages/other
      tags:
        - @idealsupply/other/v1.0.0-rc.0
\`\`\`

### Build Options

- [x] Force Rebuild (delete existing drafts and rebuild all artifacts)

### Projects

| Name | Version Group | Version | Pre-release |
`;

describe('extractPRMetadata', () => {
  it('parses a body without releaseId (PRs built before ids were recorded)', () => {
    const meta = extractPRMetadata(body);
    const projects = meta.projectsByPlaceholder.MAIN;
    expect(projects.map((p) => p.name)).toEqual([
      '@idealsupply/cxml-connection-test',
      '@idealsupply/other',
    ]);
    expect(projects[0].releaseId).toBeUndefined();
    expect(meta.forceRebuild).toBe(true);
  });

  it('parses releaseId when present and ignores a malformed one', () => {
    const withIds = setReleaseIdsInPRBody(body, { '@idealsupply/other': 420876320 }).replace(
      'cwd: .\n',
      'cwd: .\n      releaseId: nope\n',
    );
    const projects = extractPRMetadata(withIds).projectsByPlaceholder.MAIN;
    expect(projects[0].releaseId).toBeUndefined();
    expect(projects[1].releaseId).toBe(420876320);
  });
});

describe('setReleaseIdsInPRBody', () => {
  it('inserts a releaseId line after each named project and leaves the rest untouched', () => {
    const out = setReleaseIdsInPRBody(body, {
      '@idealsupply/cxml-connection-test': 1,
      '@idealsupply/other': 2,
    });
    expect(out).toContain(
      '    - name: @idealsupply/cxml-connection-test\n      releaseId: 1\n      version: 1.0.0-rc.0',
    );
    expect(out).toContain('    - name: @idealsupply/other\n      releaseId: 2\n');
    // Everything outside the YAML block is byte-identical.
    expect(out.split('```')[0]).toBe(body.split('```')[0]);
    expect(out.split('```')[2]).toBe(body.split('```')[2]);
    expect(out).toContain('- [x] Force Rebuild');
  });

  it('replaces an existing releaseId in place and keeps ids it was not given', () => {
    const first = setReleaseIdsInPRBody(body, {
      '@idealsupply/cxml-connection-test': 1,
      '@idealsupply/other': 2,
    });
    const second = setReleaseIdsInPRBody(first, { '@idealsupply/other': 3 });
    const projects = extractPRMetadata(second).projectsByPlaceholder.MAIN;
    expect(projects[0].releaseId).toBe(1);
    expect(projects[1].releaseId).toBe(3);
    expect(second.match(/releaseId:/g)).toHaveLength(2);
  });

  it('round-trips through extractPRMetadata', () => {
    const out = setReleaseIdsInPRBody(body, { '@idealsupply/cxml-connection-test': 7 });
    const projects = extractPRMetadata(out).projectsByPlaceholder.MAIN;
    expect(projects[0]).toMatchObject({ version: '1.0.0-rc.0', cwd: '.', releaseId: 7 });
    expect(projects[1].releaseId).toBeUndefined();
  });

  it('returns the body unchanged with nothing to write or no YAML block', () => {
    expect(setReleaseIdsInPRBody(body, {})).toBe(body);
    expect(setReleaseIdsInPRBody('no yaml here', { x: 1 })).toBe('no yaml here');
    expect(setReleaseIdsInPRBody(body, { '@not/listed': 1 })).toBe(body);
  });
});

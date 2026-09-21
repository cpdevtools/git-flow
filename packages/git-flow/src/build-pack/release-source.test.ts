import { describe, expect, it } from 'vitest';
import { parse, parseDocument } from 'yaml';
import { addSourceToMetadata } from './github.js';

const METADATA = `project: "@scope/pkg"
artifacts:
  - type: npm
    deploy:
      - node
    published: false
`;

describe('addSourceToMetadata', () => {
  it('records the source branch and PR as top-level keys', () => {
    const out = parse(
      addSourceToMetadata(METADATA, { branch: 'erd/wire-cut/batched-ids', prNumber: 205 }),
    );
    expect(out.branch).toBe('erd/wire-cut/batched-ids');
    expect(out.pr).toBe(205);
    expect(out.project).toBe('@scope/pkg');
    expect(out.artifacts).toHaveLength(1);
  });

  it('omits keys that have no value (manual dispatch has no PR)', () => {
    const out = parse(addSourceToMetadata(METADATA, { branch: 'main', prNumber: 0 }));
    expect(out.branch).toBe('main');
    expect(out).not.toHaveProperty('pr');
    expect(parse(addSourceToMetadata(METADATA, {}))).not.toHaveProperty('branch');
  });

  it('survives the published-flag rewrite publish-release does on the document', () => {
    const doc = parseDocument(addSourceToMetadata(METADATA, { branch: 'qq/asdf', prNumber: 7 }));
    (doc.getIn(['artifacts', 0]) as { set(k: string, v: unknown): void }).set('published', true);
    const out = parse(doc.toString());
    expect(out.branch).toBe('qq/asdf');
    expect(out.pr).toBe(7);
    expect(out.artifacts[0].published).toBe(true);
  });
});

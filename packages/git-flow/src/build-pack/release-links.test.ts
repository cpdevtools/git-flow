import { describe, expect, it } from 'vitest';
import { getReleaseTag, getReleaseUrl, parseReleaseTag } from './github.js';

describe('release links', () => {
  it('builds the tag URL a published release permanently lives at', () => {
    expect(
      getReleaseUrl(
        'IdealSupply',
        'docker-dotnet-images',
        '@idealsupply/dotnet-images',
        '10.0.0-alpha.0',
      ),
    ).toBe(
      'https://github.com/IdealSupply/docker-dotnet-images/releases/tag/@idealsupply/dotnet-images/v10.0.0-alpha.0',
    );
  });

  it('never produces a draft-only untagged- URL', () => {
    // The API's html_url for a draft is /releases/tag/untagged-<hash>: it 404s
    // while the release is a draft and dies once publish-release tags it.
    expect(getReleaseUrl('o', 'r', '@scope/pkg', '1.0.0')).not.toContain('untagged-');
  });

  it('embeds the same tag publish-release tags and reports', () => {
    const tag = getReleaseTag('@scope/pkg', '1.2.3');
    expect(getReleaseUrl('o', 'r', '@scope/pkg', '1.2.3')).toBe(
      `https://github.com/o/r/releases/tag/${tag}`,
    );
    expect(parseReleaseTag(tag)).toEqual({ name: '@scope/pkg', version: '1.2.3' });
  });
});

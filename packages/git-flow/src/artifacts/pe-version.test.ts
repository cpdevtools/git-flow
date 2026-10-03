import { describe, it, expect } from 'vitest';
import { parsePeVersion, PeParseError } from './pe-version.js';
import { buildPe, buildVersionInfo } from './pe-version.fixture.js';

describe('parsePeVersion', () => {
  it('reads ProductVersion and FileVersion strings from a PE32+ binary', () => {
    const pe = buildPe({
      versionInfo: buildVersionInfo({
        fileVersion: [1, 2, 3, 0],
        strings: { ProductVersion: '1.2.3-beta.1', FileVersion: '1.2.3.0', CompanyName: 'x' },
      }),
    });
    expect(parsePeVersion(pe)).toEqual({
      productVersion: '1.2.3-beta.1',
      fileVersion: '1.2.3.0',
      fixedFileVersion: '1.2.3.0',
    });
  });

  it('handles PE32 as well', () => {
    const pe = buildPe({
      plus: false,
      versionInfo: buildVersionInfo({ strings: { ProductVersion: '4.5.6' } }),
    });
    expect(parsePeVersion(pe).productVersion).toBe('4.5.6');
  });

  it('reports a version resource with no string table', () => {
    const pe = buildPe({ versionInfo: buildVersionInfo({ fileVersion: [2, 0, 0, 0] }) });
    const info = parsePeVersion(pe);
    expect(info.productVersion).toBeUndefined();
    expect(info.fixedFileVersion).toBe('2.0.0.0');
  });

  it('fails clearly on a PE without resources', () => {
    expect(() => parsePeVersion(buildPe())).toThrow(PeParseError);
    expect(() => parsePeVersion(buildPe())).toThrow(/no resource section/);
  });

  it('fails clearly on something that is not a PE', () => {
    expect(() => parsePeVersion(Buffer.from('#!/bin/sh\necho hi\n'))).toThrow(/missing MZ/);
    const mzOnly = Buffer.alloc(0x100);
    mzOnly.write('MZ');
    mzOnly.writeUInt32LE(0x40, 0x3c);
    expect(() => parsePeVersion(mzOnly)).toThrow(/missing PE signature/);
  });

  it('does not run off the end of a truncated resource', () => {
    const pe = buildPe({ versionInfo: buildVersionInfo({ strings: { ProductVersion: '1.0.0' } }) });
    expect(() => parsePeVersion(pe.subarray(0, pe.length - 40))).toThrow(PeParseError);
  });
});

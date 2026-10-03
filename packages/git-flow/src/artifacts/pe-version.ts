/**
 * Read the version a Windows executable carries, without running it.
 *
 * A PE file may embed a VS_VERSIONINFO resource. Its fixed part holds four
 * 16-bit numbers (1.2.3.0) and cannot express a prerelease; the string table
 * holds a free-text `ProductVersion`, which is where every toolchain puts the
 * full version (PyInstaller's version file, .NET's InformationalVersion, Go's
 * goversioninfo, Rust's winres). That string is what a release is compared to.
 *
 * Pure parsing: DOS header → PE header → resource data directory → section
 * table (RVA to file offset) → resource tree RT_VERSION/<id>/<lang> → the
 * version block tree. Works for PE32 and PE32+, on any host.
 */

import { readFile } from 'node:fs/promises';

const RT_VERSION = 16;

export interface PeVersionInfo {
  /** `ProductVersion` from the string table, if the resource has one. */
  productVersion?: string;
  /** `FileVersion` from the string table, if present. */
  fileVersion?: string;
  /** The four-part numeric file version from VS_FIXEDFILEINFO, if present. */
  fixedFileVersion?: string;
}

export class PeParseError extends Error {}

export async function readPeVersion(filePath: string): Promise<PeVersionInfo> {
  return parsePeVersion(await readFile(filePath));
}

export function parsePeVersion(buf: Buffer): PeVersionInfo {
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) {
    throw new PeParseError('not a PE file (missing MZ header)');
  }
  const peOffset = buf.readUInt32LE(0x3c);
  if (peOffset + 24 > buf.length || buf.readUInt32LE(peOffset) !== 0x00004550) {
    throw new PeParseError('not a PE file (missing PE signature)');
  }
  const numberOfSections = buf.readUInt16LE(peOffset + 6);
  const sizeOfOptionalHeader = buf.readUInt16LE(peOffset + 20);
  const optional = peOffset + 24;
  const magic = buf.readUInt16LE(optional);
  const isPlus = magic === 0x20b;
  if (!isPlus && magic !== 0x10b) {
    throw new PeParseError(`unknown optional header magic 0x${magic.toString(16)}`);
  }
  const numberOfRvaAndSizes = buf.readUInt32LE(optional + (isPlus ? 108 : 92));
  if (numberOfRvaAndSizes < 3) {
    throw new PeParseError('no resource data directory');
  }
  const dataDirectories = optional + (isPlus ? 112 : 96);
  const resourceRva = buf.readUInt32LE(dataDirectories + 2 * 8);
  const resourceSize = buf.readUInt32LE(dataDirectories + 2 * 8 + 4);
  if (resourceRva === 0 || resourceSize === 0) {
    throw new PeParseError('no resource section');
  }

  // Section table — needed to turn RVAs into file offsets.
  const sections: Array<{ va: number; size: number; raw: number }> = [];
  let sectionHeader = optional + sizeOfOptionalHeader;
  for (let i = 0; i < numberOfSections; i++, sectionHeader += 40) {
    if (sectionHeader + 40 > buf.length) break;
    const virtualSize = buf.readUInt32LE(sectionHeader + 8);
    const va = buf.readUInt32LE(sectionHeader + 12);
    const sizeOfRawData = buf.readUInt32LE(sectionHeader + 16);
    const raw = buf.readUInt32LE(sectionHeader + 20);
    sections.push({ va, size: Math.max(virtualSize, sizeOfRawData), raw });
  }
  const toOffset = (rva: number): number => {
    for (const s of sections) {
      if (rva >= s.va && rva < s.va + s.size) return rva - s.va + s.raw;
    }
    throw new PeParseError(`RVA 0x${rva.toString(16)} is outside every section`);
  };

  const resourceBase = toOffset(resourceRva);

  // Resource directory tree: type → name/id → language → data entry.
  const findEntry = (
    dirOffset: number,
    wantId?: number,
  ): { offset: number; isDir: boolean } | undefined => {
    const named = buf.readUInt16LE(dirOffset + 12);
    const ids = buf.readUInt16LE(dirOffset + 14);
    let entry = dirOffset + 16;
    for (let i = 0; i < named + ids; i++, entry += 8) {
      const id = buf.readUInt32LE(entry);
      const data = buf.readUInt32LE(entry + 4);
      const isDir = (data & 0x80000000) !== 0;
      const offset = resourceBase + (data & 0x7fffffff);
      // Named entries come first; a version resource is always id-keyed, so
      // for the type level we match the id, and below it we take the first.
      if (wantId === undefined ? i >= named : (id & 0x80000000) === 0 && id === wantId) {
        return { offset, isDir };
      }
    }
    return undefined;
  };

  const typeEntry = findEntry(resourceBase, RT_VERSION);
  if (!typeEntry?.isDir) throw new PeParseError('no VS_VERSIONINFO resource');
  const nameEntry = findEntry(typeEntry.offset);
  if (!nameEntry?.isDir) throw new PeParseError('malformed version resource (name level)');
  const langEntry = findEntry(nameEntry.offset);
  if (!langEntry || langEntry.isDir) {
    throw new PeParseError('malformed version resource (language level)');
  }
  const dataRva = buf.readUInt32LE(langEntry.offset);
  const dataSize = buf.readUInt32LE(langEntry.offset + 4);
  const dataOffset = toOffset(dataRva);
  if (dataOffset + dataSize > buf.length) {
    throw new PeParseError('version resource extends past end of file');
  }

  return parseVersionBlock(buf.subarray(dataOffset, dataOffset + dataSize));
}

/**
 * Walk the VS_VERSIONINFO block tree. Every node is
 *   wLength, wValueLength, wType, szKey (UTF-16, null-terminated), pad32,
 *   value (wValueLength bytes, or UTF-16 chars when wType = 1), pad32, children…
 */
function parseVersionBlock(data: Buffer): PeVersionInfo {
  const info: PeVersionInfo = {};
  const align4 = (n: number): number => (n + 3) & ~3;

  const walk = (start: number, end: number, depth: number): void => {
    let pos = start;
    while (pos + 6 <= end) {
      const length = data.readUInt16LE(pos);
      if (length < 6) return;
      const valueLength = data.readUInt16LE(pos + 2);
      const type = data.readUInt16LE(pos + 4);
      let keyEnd = pos + 6;
      while (keyEnd + 1 < end && data.readUInt16LE(keyEnd) !== 0) keyEnd += 2;
      const key = data.subarray(pos + 6, keyEnd).toString('utf16le');
      const valueStart = align4(keyEnd + 2);
      const valueBytes = type === 1 ? valueLength * 2 : valueLength;
      const blockEnd = Math.min(pos + length, end);

      if (depth === 0 && key === 'VS_VERSION_INFO' && valueLength >= 16) {
        // VS_FIXEDFILEINFO: dwFileVersionMS at +8, dwFileVersionLS at +12.
        const ms = data.readUInt32LE(valueStart + 8);
        const ls = data.readUInt32LE(valueStart + 12);
        info.fixedFileVersion = `${ms >>> 16}.${ms & 0xffff}.${ls >>> 16}.${ls & 0xffff}`;
      }
      if (type === 1 && (key === 'ProductVersion' || key === 'FileVersion')) {
        const raw = data.subarray(valueStart, Math.min(valueStart + valueBytes, blockEnd));
        const text = raw.toString('utf16le').replace(/\0+$/, '').trim();
        if (key === 'ProductVersion') info.productVersion = text;
        else info.fileVersion = text;
      }

      const childrenStart = align4(valueStart + valueBytes);
      if (childrenStart < blockEnd) walk(childrenStart, blockEnd, depth + 1);
      pos = align4(pos + length);
    }
  };

  walk(0, data.length, 0);
  return info;
}

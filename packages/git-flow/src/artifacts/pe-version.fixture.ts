/**
 * Test-only: synthesize a minimal PE file carrying a VS_VERSIONINFO resource,
 * so the parser and the executable artifact type are tested without binary
 * fixtures in the repository. Imported by tests only; not part of the bundle.
 */

const align4 = (n: number): number => (n + 3) & ~3;

function pad4(buf: Buffer): Buffer {
  const padded = Buffer.alloc(align4(buf.length));
  buf.copy(padded);
  return padded;
}

function block(key: string, type: 0 | 1, value: Buffer | null, children: Buffer[]): Buffer {
  const keyBuf = Buffer.from(key + '\0', 'utf16le');
  const header = Buffer.alloc(6);
  const head = pad4(Buffer.concat([header, keyBuf]));
  const val = value ? pad4(value) : Buffer.alloc(0);
  const body = Buffer.concat([head, val, ...children.map(pad4)]);
  body.writeUInt16LE(body.length, 0);
  body.writeUInt16LE(value ? (type === 1 ? value.length / 2 : value.length) : 0, 2);
  body.writeUInt16LE(type, 4);
  return body;
}

export interface VersionInfoSpec {
  /** String table entries, e.g. { ProductVersion: '1.2.3-beta.1' }. */
  strings?: Record<string, string>;
  /** Four-part numeric file version for VS_FIXEDFILEINFO. */
  fileVersion?: [number, number, number, number];
}

export function buildVersionInfo(spec: VersionInfoSpec): Buffer {
  const fixed = Buffer.alloc(52);
  fixed.writeUInt32LE(0xfeef04bd, 0); // dwSignature
  fixed.writeUInt32LE(0x00010000, 4); // dwStrucVersion
  const [a, b, c, d] = spec.fileVersion ?? [0, 0, 0, 0];
  fixed.writeUInt32LE(((a & 0xffff) << 16) | (b & 0xffff), 8);
  fixed.writeUInt32LE(((c & 0xffff) << 16) | (d & 0xffff), 12);

  const strings = Object.entries(spec.strings ?? {}).map(([k, v]) =>
    block(k, 1, Buffer.from(v + '\0', 'utf16le'), []),
  );
  const children =
    strings.length > 0
      ? [block('StringFileInfo', 1, null, [block('040904B0', 1, null, strings)])]
      : [];
  return block('VS_VERSION_INFO', 0, fixed, children);
}

export interface PeSpec {
  /** PE32+ (x64) when true, PE32 otherwise. */
  plus?: boolean;
  /** Version resource to embed; omit for a PE with no resources at all. */
  versionInfo?: Buffer;
}

export function buildPe(spec: PeSpec = {}): Buffer {
  const plus = spec.plus ?? true;
  const sizeOfOptional = plus ? 240 : 224;
  const peOffset = 0x40;
  const headersEnd = peOffset + 24 + sizeOfOptional + 40;
  const rawDataOffset = 0x400;
  const rsrcRva = 0x1000;

  // Resource section: three directory levels, one data entry, the blob.
  let rsrc = Buffer.alloc(0);
  if (spec.versionInfo) {
    const dirs = Buffer.alloc(88);
    const dir = (at: number, id: number, target: number, isDir: boolean): void => {
      dirs.writeUInt16LE(0, at + 12); // named entries
      dirs.writeUInt16LE(1, at + 14); // id entries
      dirs.writeUInt32LE(id, at + 16);
      dirs.writeUInt32LE(isDir ? (0x80000000 | target) >>> 0 : target, at + 20);
    };
    dir(0, 16, 24, true); // RT_VERSION → name level
    dir(24, 1, 48, true); // id 1 → language level
    dir(48, 0x409, 72, false); // en-US → data entry
    dirs.writeUInt32LE(rsrcRva + 88, 72); // data RVA
    dirs.writeUInt32LE(spec.versionInfo.length, 76); // size
    rsrc = Buffer.concat([dirs, spec.versionInfo]);
  }

  const file = Buffer.alloc(rawDataOffset + rsrc.length);
  file.write('MZ', 0, 'ascii');
  file.writeUInt32LE(peOffset, 0x3c);
  file.writeUInt32LE(0x00004550, peOffset);
  file.writeUInt16LE(plus ? 0x8664 : 0x14c, peOffset + 4);
  file.writeUInt16LE(1, peOffset + 6); // sections
  file.writeUInt16LE(sizeOfOptional, peOffset + 20);
  const optional = peOffset + 24;
  file.writeUInt16LE(plus ? 0x20b : 0x10b, optional);
  file.writeUInt32LE(16, optional + (plus ? 108 : 92)); // NumberOfRvaAndSizes
  const dataDirs = optional + (plus ? 112 : 96);
  if (rsrc.length > 0) {
    file.writeUInt32LE(rsrcRva, dataDirs + 16);
    file.writeUInt32LE(rsrc.length, dataDirs + 20);
  }
  const section = optional + sizeOfOptional;
  file.write('.rsrc', section, 'ascii');
  file.writeUInt32LE(rsrc.length, section + 8); // VirtualSize
  file.writeUInt32LE(rsrcRva, section + 12); // VirtualAddress
  file.writeUInt32LE(rsrc.length, section + 16); // SizeOfRawData
  file.writeUInt32LE(rawDataOffset, section + 20); // PointerToRawData
  if (headersEnd > rawDataOffset) throw new Error('fixture: headers overflow');
  rsrc.copy(file, rawDataOffset);
  return file;
}

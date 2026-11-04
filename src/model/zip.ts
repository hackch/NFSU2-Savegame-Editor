/** ZIP support for nfsu2-web backups: stored or deflated entries, no encryption or ZIP64. */

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
const UTF8_FLAG = 0x0800;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** One file or directory entry of a ZIP archive. */
export interface ZipEntry {
  name: string;
  data: Uint8Array;
  /** MS-DOS modification time and date, kept for entries the editor does not change. */
  time: number;
  date: number;
  utf8: boolean;
  versionMadeBy: number;
  internalAttributes: number;
  externalAttributes: number;
}

/** A decoded ZIP archive. */
export interface ZipArchive {
  entries: ZipEntry[];
  comment: Uint8Array;
}

/** ZIP CRC-32. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Whether bytes start like a ZIP archive. */
export function isZip(data: Uint8Array): boolean {
  return data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b
    && ((data[2] === 3 && data[3] === 4) || (data[2] === 5 && data[3] === 6));
}

function view(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function decodeName(bytes: Uint8Array, utf8: boolean): string {
  return utf8 ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : String.fromCharCode(...bytes);
}

function encodeName(name: string, utf8: boolean): Uint8Array {
  if (utf8) return new TextEncoder().encode(name);
  const out = new Uint8Array(name.length);
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code > 0xff) throw new RangeError(`ZIP entry name ${name} needs UTF-8.`);
    out[i] = code;
  }
  return out;
}

async function inflateRaw(raw: Uint8Array, size: number, name: string): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'function') throw new Error(`This browser cannot read the deflated entry ${name}.`);
  const stream = new Blob([raw as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  if (out.length !== size) throw new Error(`ZIP entry ${name} has the wrong size.`);
  return out;
}

/**
 * Reads every entry and verifies sizes and CRCs.
 * @param data ZIP bytes.
 * @returns Entries in central-directory order and the archive comment.
 */
export async function readZip(data: Uint8Array): Promise<ZipArchive> {
  const v = view(data);
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === END_SIG) { end = i; break; }
  }
  if (end < 0) throw new Error('Not a ZIP archive.');
  const diskEntries = v.getUint16(end + 8, true);
  const count = v.getUint16(end + 10, true);
  const dirSize = v.getUint32(end + 12, true);
  const dirOffset = v.getUint32(end + 16, true);
  const commentSize = v.getUint16(end + 20, true);
  if (v.getUint16(end + 4, true) !== 0 || v.getUint16(end + 6, true) !== 0 || diskEntries !== count) {
    throw new Error('Split ZIP archives are not supported.');
  }
  if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported.');
  if (dirOffset + dirSize > end || end + 22 + commentSize > data.length) throw new Error('The ZIP directory is damaged.');

  const entries: ZipEntry[] = [];
  let p = dirOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || v.getUint32(p, true) !== CENTRAL_SIG) throw new Error('The ZIP directory is damaged.');
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const time = v.getUint16(p + 12, true);
    const date = v.getUint16(p + 14, true);
    const crc = v.getUint32(p + 16, true);
    const compressedSize = v.getUint32(p + 20, true);
    const size = v.getUint32(p + 24, true);
    const nameSize = v.getUint16(p + 28, true);
    const extraSize = v.getUint16(p + 30, true);
    const fileCommentSize = v.getUint16(p + 32, true);
    const localOffset = v.getUint32(p + 42, true);
    const utf8 = (flags & UTF8_FLAG) !== 0;
    if (p + 46 + nameSize + extraSize + fileCommentSize > end) throw new Error('The ZIP directory is damaged.');
    const name = decodeName(data.subarray(p + 46, p + 46 + nameSize), utf8);
    if (flags & 1) throw new Error(`ZIP entry ${name} is encrypted.`);
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('ZIP64 archives are not supported.');
    }
    if (localOffset + 30 > data.length || v.getUint32(localOffset, true) !== LOCAL_SIG) {
      throw new Error(`ZIP entry ${name} is damaged.`);
    }
    const start = localOffset + 30 + v.getUint16(localOffset + 26, true) + v.getUint16(localOffset + 28, true);
    if (start + compressedSize > data.length) throw new Error(`ZIP entry ${name} is damaged.`);
    const raw = data.subarray(start, start + compressedSize);
    let entryData: Uint8Array;
    if (method === 0) entryData = raw.slice();
    else if (method === 8) entryData = await inflateRaw(raw, size, name);
    else throw new Error(`ZIP entry ${name} uses unsupported compression method ${method}.`);
    if (entryData.length !== size || crc32(entryData) !== crc) throw new Error(`ZIP entry ${name} failed its CRC check.`);
    entries.push({
      name, data: entryData, time, date, utf8,
      versionMadeBy: v.getUint16(p + 4, true),
      internalAttributes: v.getUint16(p + 36, true),
      externalAttributes: v.getUint32(p + 38, true),
    });
    p += 46 + nameSize + extraSize + fileCommentSize;
  }
  return { entries, comment: data.slice(end + 22, end + 22 + commentSize) };
}

/** MS-DOS time and date for a JavaScript date. */
export function dosDateTime(at = new Date()): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, at.getFullYear()));
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  };
}

/**
 * Writes a stored ZIP archive. Entry names, timestamps, attributes and the archive comment are retained.
 * @param archive Entries and archive comment.
 * @returns ZIP bytes.
 */
export function writeZip(archive: ZipArchive): Uint8Array {
  if (archive.entries.length > 0xffff) throw new RangeError('Too many ZIP entries.');
  const prepared = archive.entries.map((entry) => ({ entry, name: encodeName(entry.name, entry.utf8), crc: crc32(entry.data) }));
  const localSize = prepared.reduce((sum, item) => sum + 30 + item.name.length + item.entry.data.length, 0);
  const centralSize = prepared.reduce((sum, item) => sum + 46 + item.name.length, 0);
  const comment = archive.comment.subarray(0, 0xffff);
  const out = new Uint8Array(localSize + centralSize + 22 + comment.length);
  const v = view(out);
  const offsets: number[] = [];
  let p = 0;
  for (const { entry, name, crc } of prepared) {
    offsets.push(p);
    const flags = entry.utf8 ? UTF8_FLAG : 0;
    v.setUint32(p, LOCAL_SIG, true); v.setUint16(p + 4, 20, true); v.setUint16(p + 6, flags, true);
    v.setUint16(p + 8, 0, true); v.setUint16(p + 10, entry.time, true); v.setUint16(p + 12, entry.date, true);
    v.setUint32(p + 14, crc, true); v.setUint32(p + 18, entry.data.length, true); v.setUint32(p + 22, entry.data.length, true);
    v.setUint16(p + 26, name.length, true); v.setUint16(p + 28, 0, true);
    out.set(name, p + 30);
    out.set(entry.data, p + 30 + name.length);
    p += 30 + name.length + entry.data.length;
  }
  const dirOffset = p;
  prepared.forEach(({ entry, name, crc }, i) => {
    const flags = entry.utf8 ? UTF8_FLAG : 0;
    v.setUint32(p, CENTRAL_SIG, true); v.setUint16(p + 4, entry.versionMadeBy, true); v.setUint16(p + 6, 20, true);
    v.setUint16(p + 8, flags, true); v.setUint16(p + 10, 0, true); v.setUint16(p + 12, entry.time, true);
    v.setUint16(p + 14, entry.date, true); v.setUint32(p + 16, crc, true); v.setUint32(p + 20, entry.data.length, true);
    v.setUint32(p + 24, entry.data.length, true); v.setUint16(p + 28, name.length, true);
    v.setUint16(p + 36, entry.internalAttributes, true); v.setUint32(p + 38, entry.externalAttributes, true);
    v.setUint32(p + 42, offsets[i], true);
    out.set(name, p + 46);
    p += 46 + name.length;
  });
  v.setUint32(p, END_SIG, true); v.setUint16(p + 8, prepared.length, true); v.setUint16(p + 10, prepared.length, true);
  v.setUint32(p + 12, p - dirOffset, true); v.setUint32(p + 16, dirOffset, true); v.setUint16(p + 20, comment.length, true);
  out.set(comment, p + 22);
  return out;
}

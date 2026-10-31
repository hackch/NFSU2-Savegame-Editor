import { nfsu2Crc } from './checksum.js';
import {
  MAGIC, HEADER_SIZE, MONEY_OFF, MAX_MONEY, NAME_OFF, NAME_FIELD_SIZE, NAME_MAX_BYTES, dataView,
} from './layout.js';

const HDR_LEN_A = 0x08;
const HDR_LEN_B = 0x0c;
const HDR_CRC_A = 0x10;
const HDR_CRC_B = 0x14;
const HDR_CRC_H = 0x18;

/** Result of the structural check run before a file is accepted. */
export interface SaveCheck {
  /** True when the file looks like a 20CM career save. */
  ok: boolean;
  /** Reason for rejection when `ok` is false. */
  error?: string;
}

/** Which checksums matched. */
export interface ChecksumStatus {
  blockA: boolean;
  blockB: boolean;
  header: boolean;
}

/**
 * Byte ranges of the two data blocks, from the header lengths.
 * @param data Save bytes.
 * @returns Start and end (exclusive) of block A and block B.
 */
function blockRanges(data: Uint8Array): { a: { start: number; end: number }; b: { start: number; end: number } } {
  const v = dataView(data);
  const lenA = v.getUint32(HDR_LEN_A, true);
  const lenB = v.getUint32(HDR_LEN_B, true);
  const a = { start: HEADER_SIZE, end: HEADER_SIZE + lenA };
  const b = { start: a.end, end: a.end + lenB };
  return { a, b };
}

/**
 * Checks magic, header size and block lengths.
 * @param data Candidate save bytes.
 * @returns `{ ok: true }` or the reason it was rejected.
 */
export function checkSave(data: Uint8Array): SaveCheck {
  if (data.length < HEADER_SIZE) return { ok: false, error: 'File is too small to be a save.' };
  if (MAGIC.some((byte, i) => data[i] !== byte)) return { ok: false, error: 'Not a 20CM NFSU2 career save.' };
  if (dataView(data).getUint16(0x04, true) !== (data.length & 0xffff)) {
    return { ok: false, error: 'Header size does not match the file length.' };
  }
  const { b } = blockRanges(data);
  if (b.end !== data.length) return { ok: false, error: 'Block lengths do not match the file length.' };
  return { ok: true };
}

/**
 * Compares the stored checksums with freshly computed ones.
 * @param data Save bytes.
 * @returns Per-checksum match flags.
 */
export function verifyChecksums(data: Uint8Array): ChecksumStatus {
  const v = dataView(data);
  const { a, b } = blockRanges(data);
  return {
    blockA: nfsu2Crc(data, a.start, a.end) === v.getUint32(HDR_CRC_A, true),
    blockB: nfsu2Crc(data, b.start, b.end) === v.getUint32(HDR_CRC_B, true),
    header: nfsu2Crc(data, 0, HEADER_SIZE - 4) === v.getUint32(HDR_CRC_H, true),
  };
}

/**
 * Returns a copy with all three checksums rewritten.
 * Block CRCs come first, then the header CRC, since the header stores the block CRCs.
 * @param data Save bytes. Not mutated.
 * @returns A new array with valid checksums.
 */
export function recalculateChecksums(data: Uint8Array): Uint8Array {
  const out = data.slice();
  const v = dataView(out);
  const { a, b } = blockRanges(out);
  v.setUint32(HDR_CRC_A, nfsu2Crc(out, a.start, a.end), true);
  v.setUint32(HDR_CRC_B, nfsu2Crc(out, b.start, b.end), true);
  v.setUint32(HDR_CRC_H, nfsu2Crc(out, 0, HEADER_SIZE - 4), true);
  return out;
}

/**
 * Reads the career money.
 * @param data Save bytes.
 * @returns Signed 32-bit money value.
 */
export function getMoney(data: Uint8Array): number {
  return dataView(data).getInt32(MONEY_OFF, true);
}

/**
 * Returns a copy with new money.
 * @param data Save bytes. Not mutated.
 * @param value Whole number from 0 to {@link MAX_MONEY}.
 * @returns A new array.
 * @throws RangeError when the value is not a whole number in range.
 */
export function setMoney(data: Uint8Array, value: number): Uint8Array {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > MAX_MONEY) {
    throw new RangeError(`Money must be a whole number from 0 to ${MAX_MONEY}.`);
  }
  const out = data.slice();
  dataView(out).setInt32(MONEY_OFF, n, true);
  return out;
}

/**
 * Reads the driver name up to the first zero byte.
 * @param data Save bytes.
 * @returns The name as Latin-1 text.
 */
export function getName(data: Uint8Array): string {
  let s = '';
  for (let i = 0; i < NAME_FIELD_SIZE; i++) {
    const c = data[NAME_OFF + i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/**
 * Checks a driver name against the field rules.
 * @param name Proposed name.
 * @returns An error message, or `null` when the name is valid.
 */
export function validateName(name: string): string | null {
  if (typeof name !== 'string' || name.length === 0) return 'Name cannot be empty.';
  for (const ch of name) {
    if (ch.charCodeAt(0) > 0xff) return 'Name may only use Latin-1 characters.';
  }
  if (name.length > NAME_MAX_BYTES) return `Name must be at most ${NAME_MAX_BYTES} characters.`;
  return null;
}

/**
 * Returns a copy with a new driver name. The field is zero-padded.
 * @param data Save bytes. Not mutated.
 * @param name Name that passes {@link validateName}.
 * @returns A new array.
 * @throws RangeError when the name is invalid.
 */
export function setName(data: Uint8Array, name: string): Uint8Array {
  const error = validateName(name);
  if (error) throw new RangeError(error);
  const out = data.slice();
  for (let i = 0; i < NAME_FIELD_SIZE; i++) {
    out[NAME_OFF + i] = i < name.length ? name.charCodeAt(i) : 0;
  }
  return out;
}

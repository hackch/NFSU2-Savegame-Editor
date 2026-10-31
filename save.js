import { nfsu2Crc } from './crc32.js';
import { PERF_PARTS } from './perf-parts.js';

export const MAGIC = [0x32, 0x30, 0x43, 0x4d];
export const HEADER_SIZE = 0x1c;
export const MONEY_OFF = 0xa16a;
export const NAME_OFF = 0xd225;
export const NAME_FIELD_SIZE = 32;
export const NAME_MAX_BYTES = 31;
export const SLOT_BASE = 0x5870;
export const SLOT_STRIDE = 0x7f2;
export const SLOT_COUNT = 5;
export const SLOT_USED_OFF = 0x27c;
export const SLOT_HEADER_LEN = 24;
export const CAR_KEY_REL = 0x2bc;
export const PERF_OFF = 0x310;
export const PERF_COUNT = PERF_PARTS.length;
export const MAX_MONEY = 0x7fffffff;

const HDR_LEN_A = 0x08;
const HDR_LEN_B = 0x0c;
const HDR_CRC_A = 0x10;
const HDR_CRC_B = 0x14;
const HDR_CRC_H = 0x18;

function view(data) {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function blockRanges(data) {
  const v = view(data);
  const lenA = v.getUint32(HDR_LEN_A, true);
  const lenB = v.getUint32(HDR_LEN_B, true);
  const a = { start: HEADER_SIZE, end: HEADER_SIZE + lenA };
  const b = { start: a.end, end: a.end + lenB };
  return { a, b };
}

export function checkSave(data) {
  if (data.length < HEADER_SIZE) return { ok: false, error: 'File is too small to be a save.' };
  if (MAGIC.some((byte, i) => data[i] !== byte)) return { ok: false, error: 'Not a 20CM NFSU2 career save.' };
  const v = view(data);
  if (v.getUint16(0x04, true) !== (data.length & 0xffff)) {
    return { ok: false, error: 'Header size does not match the file length.' };
  }
  const { b } = blockRanges(data);
  if (b.end !== data.length) return { ok: false, error: 'Block lengths do not match the file length.' };
  return { ok: true };
}

export function verifyChecksums(data) {
  const v = view(data);
  const { a, b } = blockRanges(data);
  return {
    blockA: nfsu2Crc(data, a.start, a.end) === v.getUint32(HDR_CRC_A, true),
    blockB: nfsu2Crc(data, b.start, b.end) === v.getUint32(HDR_CRC_B, true),
    header: nfsu2Crc(data, 0, HEADER_SIZE - 4) === v.getUint32(HDR_CRC_H, true),
  };
}

// Block CRCs first, then the header CRC, since the header stores the block CRCs.
export function recalculateChecksums(data) {
  const out = data.slice();
  const v = view(out);
  const { a, b } = blockRanges(out);
  v.setUint32(HDR_CRC_A, nfsu2Crc(out, a.start, a.end), true);
  v.setUint32(HDR_CRC_B, nfsu2Crc(out, b.start, b.end), true);
  v.setUint32(HDR_CRC_H, nfsu2Crc(out, 0, HEADER_SIZE - 4), true);
  return out;
}

export function getMoney(data) {
  return view(data).getInt32(MONEY_OFF, true);
}

export function setMoney(data, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > MAX_MONEY) {
    throw new RangeError(`Money must be a whole number from 0 to ${MAX_MONEY}.`);
  }
  const out = data.slice();
  view(out).setInt32(MONEY_OFF, n, true);
  return out;
}

export function getName(data) {
  let s = '';
  for (let i = 0; i < NAME_FIELD_SIZE; i++) {
    const c = data[NAME_OFF + i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

export function validateName(name) {
  if (typeof name !== 'string' || name.length === 0) return 'Name cannot be empty.';
  for (const ch of name) {
    if (ch.charCodeAt(0) > 0xff) return 'Name may only use Latin-1 characters.';
  }
  if (name.length > NAME_MAX_BYTES) return `Name must be at most ${NAME_MAX_BYTES} characters.`;
  return null;
}

export function setName(data, name) {
  const error = validateName(name);
  if (error) throw new RangeError(error);
  const out = data.slice();
  for (let i = 0; i < NAME_FIELD_SIZE; i++) {
    out[NAME_OFF + i] = i < name.length ? name.charCodeAt(i) : 0;
  }
  return out;
}

export function isSlotUsed(data, slot) {
  return view(data).getUint16(slotBase(slot) + SLOT_USED_OFF, true) !== 0;
}

// Upper-case hex of the 4 model-key bytes at the end of the +0x2B0 block. "00000000" means no car.
export function getCarKey(data, slot) {
  const start = slotBase(slot) + CAR_KEY_REL;
  return Array.from(data.subarray(start, start + 4), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// Writes a donor's slot blocks (in the order given) and keeps tuning, name and money.
// An empty slot also gets the used header copied from the first slot in use (unverified in-game).
export function setSlotCar(data, slot, donor) {
  const base = slotBase(slot);
  const needsHeader = !isSlotUsed(data, slot);
  let template = -1;
  if (needsHeader) {
    for (let i = 0; i < SLOT_COUNT && template < 0; i++) {
      if (i !== slot && isSlotUsed(data, i)) template = i;
    }
    if (template < 0) throw new RangeError('No car is in use, so there is no slot header to copy.');
  }
  for (const block of donor.blocks) {
    const rel = block.off - SLOT_BASE;
    if (rel < 0 || rel + block.bytes.length > SLOT_STRIDE) {
      throw new RangeError('Donor block does not fit inside a car slot.');
    }
  }
  const out = data.slice();
  for (const block of donor.blocks) {
    out.set(block.bytes, base + block.off - SLOT_BASE);
  }
  if (needsHeader) {
    const header = data.slice(slotBase(template) + SLOT_USED_OFF, slotBase(template) + SLOT_USED_OFF + SLOT_HEADER_LEN);
    out.set(header, base + SLOT_USED_OFF);
  }
  return out;
}

export function getPerfFlag(data, slot, index) {
  return data[perfOffset(slot, index)] !== 0;
}

export function setPerfFlag(data, slot, index, on) {
  const out = data.slice();
  out[perfOffset(slot, index)] = on ? 1 : 0;
  return out;
}

export function setPerfFlags(data, slot, indices, on) {
  const out = data.slice();
  for (const index of indices) {
    out[perfOffset(slot, index)] = on ? 1 : 0;
  }
  return out;
}

// Experimental: copies the whole slot block. Cross-references elsewhere in the save are not updated.
export function swapSlots(data, slotA, slotB) {
  if (slotA === slotB) return data.slice();
  const out = data.slice();
  const a = slotBase(slotA);
  const b = slotBase(slotB);
  const blockA = data.slice(a, a + SLOT_STRIDE);
  out.set(data.subarray(b, b + SLOT_STRIDE), a);
  out.set(blockA, b);
  return out;
}

function slotBase(slot) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_COUNT) {
    throw new RangeError(`Slot must be 0 to ${SLOT_COUNT - 1}.`);
  }
  return SLOT_BASE + slot * SLOT_STRIDE;
}

function perfOffset(slot, index) {
  if (!Number.isInteger(index) || index < 0 || index >= PERF_COUNT) {
    throw new RangeError(`Part index must be 0 to ${PERF_COUNT - 1}.`);
  }
  return slotBase(slot) + PERF_OFF + index;
}

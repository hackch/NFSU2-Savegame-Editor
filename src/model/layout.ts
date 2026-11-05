/**
 * Byte layout of an NFSU2 career save and small binary helpers shared by the model modules.
 * Offsets are absolute unless a name says `REL` (relative to the start of a car slot).
 */

/** `20CM` file magic. */
export const MAGIC = [0x32, 0x30, 0x43, 0x4d];
/** Size of the header; block A starts right after it. */
export const HEADER_SIZE = 0x1c;
/** Money, signed 32-bit little endian. */
export const MONEY_OFF = 0xa16a;
/** Largest money value the game field can hold. */
export const MAX_MONEY = 0x7fffffff;
/** Driver name field. */
export const NAME_OFF = 0xd225;
/** Bytes reserved for the name, including the terminator. */
export const NAME_FIELD_SIZE = 32;
/** Longest name the editor accepts. */
export const NAME_MAX_BYTES = 31;
/** Absolute offset of car slot 0. */
export const SLOT_BASE = 0x5870;
/** Distance between car slots. */
export const SLOT_STRIDE = 0x7f2;
/** Number of car slots in a career save. */
export const SLOT_COUNT = 5;
/** Native car records start 8 bytes before the editor's slot base; record +4 is the `CAREER_SLOT_<n>` handle. */
export const SLOT_RECORD_REL = -8;
/** Slot-relative end of a native 2,034-byte car record. */
export const SLOT_RECORD_END_REL = SLOT_STRIDE + SLOT_RECORD_REL;
/** Size of the career saves nfsu2-web pairs with a GARAGE.DAT. */
export const PROFILE_SIZE = 54966;
/** Slots 6-10 from an nfsu2-web GARAGE.DAT are kept after the career bytes in the editor's working buffer. */
export const EXTRA_SLOT_RECORD_BASE = PROFILE_SIZE;
/** Number of slots with nfsu2-web's GARAGE.DAT. */
export const MAX_SLOT_COUNT = 10;
/** Length of a career save plus its five GARAGE.DAT records. */
export const EXTENDED_SAVE_SIZE = EXTRA_SLOT_RECORD_BASE + SLOT_COUNT * SLOT_STRIDE;
/** Legacy replacement-template start (window tint); this is not an ownership/usage flag. */
export const SLOT_USED_OFF = 0x27c;
/** Slot-relative model key (last 4 bytes of the `+0x2B0` block). */
export const CAR_KEY_REL = 0x2bc;
/** Slot-relative car type hash, matching the GLOBALB.BUN car record. */
export const CAR_TYPE_HASH_REL = 0x14;
/** Slot-relative lock flag; non-zero means the slot is locked. */
export const SLOT_LOCK_REL = 0x428;
/** Slot-relative "car bought" flag; zero on an unlocked slot means it is open for a sponsor car. */
export const SLOT_BOUGHT_REL = 0x429;
/** Current career-stage index, uint32 LE; not a garage count. */
export const CURRENT_STAGE_OFF = 0xa175;
/** Slot-relative start of the performance part flags, one byte per part. */
export const PERF_OFF = 0x310;
/** Slot-relative start and count of saved visual-part hashes. */
export const VISUAL_OFF = 0x18;
export const VISUAL_COUNT = 170;
/** Slot-relative start of nine unique-performance uint32 fields. */
export const UNIQUE_PERF_OFF = 0x2e8;
/** Slot-relative start of the indexed performance ownership bitset. */
export const PERF_PURCHASE_OFF = 0x586;

/**
 * DataView over the same bytes as a Uint8Array.
 * @param data Save bytes.
 * @returns A view that respects the array's byteOffset.
 */
export function dataView(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Absolute offset of a car slot.
 * @param slot Slot index, 0 to {@link MAX_SLOT_COUNT} - 1. Slots 5-9 exist only in an extended buffer.
 * @returns Offset of the first byte of that slot.
 * @throws RangeError when the slot index is out of range.
 */
export function slotBase(slot: number): number {
  if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_SLOT_COUNT) {
    throw new RangeError(`Slot must be 0 to ${MAX_SLOT_COUNT - 1}.`);
  }
  if (slot < SLOT_COUNT) return SLOT_BASE + slot * SLOT_STRIDE;
  return EXTRA_SLOT_RECORD_BASE + (slot - SLOT_COUNT) * SLOT_STRIDE - SLOT_RECORD_REL;
}

/**
 * Number of car slots present in the working buffer.
 * @param data Career bytes, optionally followed by GARAGE.DAT records.
 * @returns 10 for an extended nfsu2-web buffer, otherwise 5.
 */
export function slotCount(data: Uint8Array): number {
  return data.length === EXTENDED_SAVE_SIZE ? MAX_SLOT_COUNT : SLOT_COUNT;
}

/**
 * Validates a slot against the bytes being edited.
 * @param data Working bytes.
 * @param slot Slot index.
 * @returns Absolute slot base.
 * @throws RangeError when the slot is not present in this buffer.
 */
export function checkedSlotBase(data: Uint8Array, slot: number): number {
  const count = slotCount(data);
  if (!Number.isInteger(slot) || slot < 0 || slot >= count) {
    throw new RangeError(`Slot must be 0 to ${count - 1}.`);
  }
  return slotBase(slot);
}

/**
 * Upper-case hex string of a byte range.
 * @param bytes Bytes to format.
 * @returns Two hex digits per byte, e.g. `0A1B`.
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

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
/** Number of car slots. */
export const SLOT_COUNT = 5;
/** Slot-relative used header; a non-zero uint16 means the slot holds a car. */
export const SLOT_USED_OFF = 0x27c;
/** Length of the used header copied when a slot is filled. */
export const SLOT_HEADER_LEN = 24;
/** Slot-relative model key (last 4 bytes of the `+0x2B0` block). */
export const CAR_KEY_REL = 0x2bc;
/** Slot-relative link block; all zero means it is not linked. */
export const SLOT_LINK_OFF = 0x294;
/** Length of the link block. */
export const SLOT_LINK_LEN = 16;
/** Slot-relative lock flag; non-zero means the slot is locked. */
export const SLOT_LOCK_REL = 0x428;
/** Garage car count byte. Not the lock; the per-slot flag above decides it. */
export const GARAGE_CAR_COUNT = 0xa175;
/** Cap of the garage car count. */
export const GARAGE_CAR_MAX = 6;
/** Slot-relative start of the performance part flags, one byte per part. */
export const PERF_OFF = 0x310;

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
 * @param slot Slot index, 0 to {@link SLOT_COUNT} - 1.
 * @returns Offset of the first byte of that slot.
 * @throws RangeError when the slot index is out of range.
 */
export function slotBase(slot: number): number {
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_COUNT) {
    throw new RangeError(`Slot must be 0 to ${SLOT_COUNT - 1}.`);
  }
  return SLOT_BASE + slot * SLOT_STRIDE;
}

/**
 * Upper-case hex string of a byte range.
 * @param bytes Bytes to format.
 * @returns Two hex digits per byte, e.g. `0A1B`.
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

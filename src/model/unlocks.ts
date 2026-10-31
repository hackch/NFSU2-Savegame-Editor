import { UNLOCK_CATEGORY_OFFSETS, UNLOCK_OFFSETS, type UnlockCategory } from '../data/unlock-table.js';
import { slotBase } from './layout.js';

/** Number of unlock-table bytes per slot. */
export const UNLOCK_COUNT = UNLOCK_OFFSETS.length;

/** Byte value that marks an unlock as on. */
const ON = 0xff;
/** Byte value that marks an unlock as off. */
const OFF = 0x00;

/**
 * Counts unlocked bytes among a set of slot-relative offsets.
 * @param data Save bytes.
 * @param slot Slot index.
 * @param offsets Slot-relative offsets to test.
 * @returns How many of them are 0xFF.
 */
function countOffsets(data: Uint8Array, slot: number, offsets: number[]): number {
  const base = slotBase(slot);
  let count = 0;
  for (const rel of offsets) {
    if (data[base + rel] === ON) count++;
  }
  return count;
}

/**
 * Writes 0xFF or 0x00 to a set of slot-relative offsets.
 * @param data Save bytes. Not mutated.
 * @param slot Slot index.
 * @param offsets Slot-relative offsets to write.
 * @param on True writes 0xFF, false writes 0x00.
 * @returns A new array.
 */
function writeOffsets(data: Uint8Array, slot: number, offsets: number[], on: boolean): Uint8Array {
  const base = slotBase(slot);
  const out = data.slice();
  const value = on ? ON : OFF;
  for (const rel of offsets) {
    out[base + rel] = value;
  }
  return out;
}

/**
 * Number of unlock-table bytes set to 0xFF in a slot.
 * @param data Save bytes.
 * @param slot Slot index.
 * @returns Count out of {@link UNLOCK_COUNT}.
 */
export function countUnlocked(data: Uint8Array, slot: number): number {
  return countOffsets(data, slot, UNLOCK_OFFSETS);
}

/**
 * Sets the whole unlock table of a slot. Only those bytes change.
 * @param data Save bytes. Not mutated.
 * @param slot Slot index.
 * @param on True unlocks everything, false clears it.
 * @returns A new array.
 */
export function setUnlocks(data: Uint8Array, slot: number, on: boolean): Uint8Array {
  return writeOffsets(data, slot, UNLOCK_OFFSETS, on);
}

/**
 * Number of a category's unlock bytes set to 0xFF in a slot.
 * @param data Save bytes.
 * @param slot Slot index.
 * @param category Unlock category.
 * @returns Count of unlocked bytes in that category.
 */
export function countUnlockedCategory(data: Uint8Array, slot: number, category: UnlockCategory): number {
  return countOffsets(data, slot, UNLOCK_CATEGORY_OFFSETS[category]);
}

/**
 * Sets one category's unlock bytes. Other bytes are untouched.
 * @param data Save bytes. Not mutated.
 * @param slot Slot index.
 * @param category Unlock category.
 * @param on True unlocks the category, false clears it.
 * @returns A new array.
 */
export function setUnlockCategory(data: Uint8Array, slot: number, category: UnlockCategory, on: boolean): Uint8Array {
  return writeOffsets(data, slot, UNLOCK_CATEGORY_OFFSETS[category], on);
}

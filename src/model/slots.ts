import type { Donor } from './cars.js';

/** What a car slot shows: locked, unlocked with no car bought (open for a sponsor car), or filled with a bought car. */
export type SlotState = 'locked' | 'open' | 'filled';
import {
  dataView, bytesToHex, checkedSlotBase, slotBase, SLOT_BASE, SLOT_COUNT, CAR_KEY_REL, CAR_TYPE_HASH_REL,
  SLOT_LOCK_REL, SLOT_BOUGHT_REL, SLOT_RECORD_END_REL, PERF_OFF,
  VISUAL_OFF, VISUAL_COUNT,
} from './layout.js';
import { PERF_COUNT } from './perf.js';
import { TRAFFIC_CARS } from '../data/traffic-cars.js';

/**
 * Whether a slot holds a bought car. Customization hashes do not indicate ownership.
 * @param data Save bytes.
 * @param slot Slot index.
 * @returns True when the per-slot bought flag is non-zero.
 */
export function isSlotUsed(data: Uint8Array, slot: number): boolean {
  return isCarBought(data, slot);
}

/**
 * Shared model key of the car in a slot; not unique enough for car identification.
 * @param data Save bytes.
 * @param slot Slot index.
 * @returns Upper-case hex, 8 digits. `00000000` means no car.
 */
export function getCarKey(data: Uint8Array, slot: number): string {
  const start = slotBase(slot) + CAR_KEY_REL;
  return bytesToHex(data.subarray(start, start + 4));
}

/** Car type hash used by the game physics tables and slot-name identification. */
export function getCarTypeHash(data: Uint8Array, slot: number): number {
  return dataView(data).getUint32(slotBase(slot) + CAR_TYPE_HASH_REL, true);
}

/** Experimental identity-only edit; traffic body/customization data is not mapped. */
export function setSlotTrafficCar(data: Uint8Array, slot: number, hash: number): Uint8Array {
  const base = checkedSlotBase(data, slot);
  if (!TRAFFIC_CARS.some((car) => car.hash === hash)) throw new RangeError('Unknown traffic vehicle.');
  if (slotState(data, slot) !== 'filled' || !isSlotUsed(data, slot)) {
    throw new RangeError('Traffic experiments require an unlocked, filled car slot.');
  }
  const out = data.slice();
  dataView(out).setUint32(base + CAR_TYPE_HASH_REL, hash, true);
  return out;
}

/**
 * Whether a slot is locked, from its own lock flag. Locked slots can hold a car but cannot be used.
 * @param data Save bytes.
 * @param slot Slot index.
 * @returns True when the slot's lock flag is non-zero.
 */
export function isSlotLocked(data: Uint8Array, slot: number): boolean {
  return data[slotBase(slot) + SLOT_LOCK_REL] !== 0;
}

/**
 * Whether the slot holds a bought car. An unlocked slot without one is open for a sponsor car.
 * @param data Save bytes.
 * @param slot Slot index.
 * @returns True when the slot's bought flag is non-zero.
 */
export function isCarBought(data: Uint8Array, slot: number): boolean {
  return data[slotBase(slot) + SLOT_BOUGHT_REL] !== 0;
}

/**
 * What a slot shows: locked takes priority, then filled when a car is bought, otherwise open.
 * @param data Save bytes.
 * @param slot Slot index.
 * @returns `locked`, `filled` or `open`.
 */
export function slotState(data: Uint8Array, slot: number): SlotState {
  if (isSlotLocked(data, slot)) return 'locked';
  return isCarBought(data, slot) ? 'filled' : 'open';
}

/**
 * Writes a donor car into a slot.
 * Appearance is reset before applying donor blocks; vinyls, decals and neon are removed.
 * Name, money and dyno setups are kept; the slot's part flags are reset to stock.
 * The slot's lock flag is cleared and its bought flag is set. Career slots 1-5 also raise the garage count (0xA175) as before.
 * @param data Save bytes. Not mutated.
 * @param slot Target slot.
 * @param donor Car to write.
 * @returns A new array.
 * @throws RangeError when a donor block does not fit.
 */
export function setSlotCar(data: Uint8Array, slot: number, donor: Donor): Uint8Array {
  const base = checkedSlotBase(data, slot);
  for (const block of donor.blocks) {
    const rel = block.off - SLOT_BASE;
    if (rel < 0 || rel + block.bytes.length > SLOT_RECORD_END_REL) {
      throw new RangeError('Donor block does not fit inside a car slot.');
    }
  }
  const out = data.slice();
  out.fill(0, base + VISUAL_OFF, base + VISUAL_OFF + VISUAL_COUNT * 4);
  for (const block of donor.blocks) {
    out.set(block.bytes, base + block.off - SLOT_BASE);
  }
  // Donor variants can contain vinyls too. Never carry stickers or neon into a replacement.
  for (const [first, end] of [[64,68], [77,93], [97,153], [154,159]]) {
    out.fill(0, base + VISUAL_OFF + first * 4, base + VISUAL_OFF + end * 4);
  }
  // The donor blocks stop before the part flags, so without this the old car's parts would stay installed.
  out.fill(0, base + PERF_OFF, base + PERF_OFF + PERF_COUNT);
  out[base + SLOT_LOCK_REL] = 0;
  out[base + SLOT_BOUGHT_REL] = 1;
  return out;
}

/**
 * Sets or clears a slot's own lock flag. The bought flag and car blocks are left as they are.
 * @param data Save bytes. Not mutated.
 * @param slot Slot index.
 * @param locked True to lock the slot, false to unlock it.
 * @returns A new array with only the slot's lock flag changed.
 */
export function setSlotLocked(data: Uint8Array, slot: number, locked: boolean): Uint8Array {
  const out = data.slice();
  out[checkedSlotBase(data, slot) + SLOT_LOCK_REL] = locked ? 1 : 0;
  return out;
}

/**
 * Exchanges the car data of two native records while each slot keeps its own `CAREER_SLOT_<n>` handle.
 * Experimental: cross-references elsewhere in the save are not updated.
 * @param data Save bytes. Not mutated.
 * @param slotA First slot.
 * @param slotB Second slot.
 * @returns A new array with the two slots' car data exchanged.
 */
export function swapSlots(data: Uint8Array, slotA: number, slotB: number): Uint8Array {
  const a = checkedSlotBase(data, slotA);
  const b = checkedSlotBase(data, slotB);
  if (slotA === slotB) return data.slice();
  const out = data.slice();
  const blockA = data.slice(a, a + SLOT_RECORD_END_REL);
  out.set(data.subarray(b, b + SLOT_RECORD_END_REL), a);
  out.set(blockA, b);
  return out;
}

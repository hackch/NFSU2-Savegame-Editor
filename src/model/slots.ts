import type { Donor } from './cars.js';
import {
  dataView, bytesToHex, slotBase, SLOT_BASE, SLOT_COUNT, SLOT_STRIDE, SLOT_USED_OFF, SLOT_HEADER_LEN, CAR_KEY_REL,
  SLOT_LINK_OFF, SLOT_LINK_LEN, SLOT_LOCK_REL, GARAGE_CAR_COUNT, GARAGE_CAR_MAX, PERF_OFF,
} from './layout.js';
import { PERF_COUNT } from './perf.js';

/**
 * Whether a slot holds a car, from its used header.
 * @param data Save bytes.
 * @param slot Slot index.
 * @returns True when the used header is non-zero.
 */
export function isSlotUsed(data: Uint8Array, slot: number): boolean {
  return dataView(data).getUint16(slotBase(slot) + SLOT_USED_OFF, true) !== 0;
}

/**
 * Model key of the car in a slot.
 * @param data Save bytes.
 * @param slot Slot index.
 * @returns Upper-case hex, 8 digits. `00000000` means no car.
 */
export function getCarKey(data: Uint8Array, slot: number): string {
  const start = slotBase(slot) + CAR_KEY_REL;
  return bytesToHex(data.subarray(start, start + 4));
}

/**
 * Whether the slot's link block is filled.
 * @param data Save bytes.
 * @param slot Slot index.
 * @returns True when any byte of the link block is non-zero.
 */
export function isSlotLinked(data: Uint8Array, slot: number): boolean {
  const start = slotBase(slot) + SLOT_LINK_OFF;
  return data.subarray(start, start + SLOT_LINK_LEN).some((b) => b !== 0);
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
 * First slot other than `slot` that satisfies the predicate.
 * @param data Save bytes.
 * @param slot Slot to skip (use -1 to skip none).
 * @param predicate Test applied to each other slot.
 * @returns The slot index, or -1.
 */
function findOtherSlot(data: Uint8Array, slot: number, predicate: (d: Uint8Array, i: number) => boolean): number {
  for (let i = 0; i < SLOT_COUNT; i++) {
    if (i !== slot && predicate(data, i)) return i;
  }
  return -1;
}

/**
 * Writes a donor car into a slot.
 * Donor blocks are written in order, and the slot's part flags are reset to stock.
 * Name and money are kept. An empty slot also gets the used header and link block copied from another slot.
 * The slot's lock flag is cleared, and the garage count (0xA175) is raised as before.
 * @param data Save bytes. Not mutated.
 * @param slot Target slot.
 * @param donor Car to write.
 * @returns A new array.
 * @throws RangeError when no slot is in use to copy a header from, or a donor block does not fit.
 */
export function setSlotCar(data: Uint8Array, slot: number, donor: Donor): Uint8Array {
  const base = slotBase(slot);
  const needsHeader = !isSlotUsed(data, slot);
  const needsLink = !isSlotLinked(data, slot);
  const headerTemplate = needsHeader ? findOtherSlot(data, slot, isSlotUsed) : -1;
  if (needsHeader && headerTemplate < 0) throw new RangeError('No car is in use, so there is no slot header to copy.');
  const linkTemplate = needsLink ? findOtherSlot(data, slot, isSlotLinked) : -1;
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
  // The donor blocks stop before the part flags, so without this the old car's parts would stay installed.
  out.fill(0, base + PERF_OFF, base + PERF_OFF + PERF_COUNT);
  out[base + SLOT_LOCK_REL] = 0;
  if (needsHeader) {
    const header = data.slice(slotBase(headerTemplate) + SLOT_USED_OFF, slotBase(headerTemplate) + SLOT_USED_OFF + SLOT_HEADER_LEN);
    out.set(header, base + SLOT_USED_OFF);
  }
  if (linkTemplate >= 0) {
    const link = data.slice(slotBase(linkTemplate) + SLOT_LINK_OFF, slotBase(linkTemplate) + SLOT_LINK_OFF + SLOT_LINK_LEN);
    out.set(link, base + SLOT_LINK_OFF);
  }
  out[GARAGE_CAR_COUNT] = Math.max(out[GARAGE_CAR_COUNT], Math.min(slot + 1, GARAGE_CAR_MAX));
  return out;
}

/**
 * Sandbox-style unlock: clears every slot's lock flag, raises the garage count to its cap and fills empty link blocks from a linked slot.
 * Car blocks and headers are left alone, so empty slots stay empty.
 * @param data Save bytes. Not mutated.
 * @returns A new array.
 */
export function unlockAllSlots(data: Uint8Array): Uint8Array {
  const out = data.slice();
  out[GARAGE_CAR_COUNT] = GARAGE_CAR_MAX;
  for (let i = 0; i < SLOT_COUNT; i++) out[slotBase(i) + SLOT_LOCK_REL] = 0;
  const template = findOtherSlot(data, -1, isSlotLinked);
  if (template < 0) return out;
  const link = data.slice(slotBase(template) + SLOT_LINK_OFF, slotBase(template) + SLOT_LINK_OFF + SLOT_LINK_LEN);
  for (let i = 0; i < SLOT_COUNT; i++) {
    if (!isSlotLinked(data, i)) out.set(link, slotBase(i) + SLOT_LINK_OFF);
  }
  return out;
}

/**
 * Copies a whole slot block to another slot and back.
 * Experimental: cross-references elsewhere in the save are not updated.
 * @param data Save bytes. Not mutated.
 * @param slotA First slot.
 * @param slotB Second slot.
 * @returns A new array with the two slot blocks exchanged.
 */
export function swapSlots(data: Uint8Array, slotA: number, slotB: number): Uint8Array {
  if (slotA === slotB) return data.slice();
  const out = data.slice();
  const a = slotBase(slotA);
  const b = slotBase(slotB);
  const blockA = data.slice(a, a + SLOT_STRIDE);
  out.set(data.subarray(b, b + SLOT_STRIDE), a);
  out.set(blockA, b);
  return out;
}

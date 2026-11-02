import { PERF_PARTS, UNIQUE_PERF_PARTS } from '../data/perf-parts.js';
import { dataView, slotBase, PERF_OFF, PERF_PURCHASE_OFF, UNIQUE_PERF_OFF } from './layout.js';

/** Number of performance part flags. */
export const PERF_COUNT = PERF_PARTS.length;
export const UNIQUE_PERF_COUNT = UNIQUE_PERF_PARTS.length;

function validatePartIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= PERF_COUNT) {
    throw new RangeError(`Part index must be 0 to ${PERF_COUNT - 1}.`);
  }
}

/**
 * Absolute address of one installed-part flag.
 * @param slot Slot index.
 * @param index Part index, 0 to {@link PERF_COUNT} - 1.
 * @returns Absolute byte offset.
 * @throws RangeError when the part index is out of range.
 */
export function perfOffset(slot: number, index: number): number {
  validatePartIndex(index);
  return slotBase(slot) + PERF_OFF + index;
}

/** Absolute byte containing an item's ownership bit; not an installed flag. */
export function perfPurchaseOffset(slot: number, index: number): number {
  validatePartIndex(index);
  return slotBase(slot) + PERF_PURCHASE_OFF + (index >> 3);
}

/** Read-only interpretation of the game's indexed ownership bitset. */
export function getPerfPurchased(data: Uint8Array, slot: number, index: number): boolean {
  return (dataView(data).getUint8(perfPurchaseOffset(slot, index)) & (1 << (index & 7))) !== 0;
}

export function uniquePerfOffset(slot: number, index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= UNIQUE_PERF_COUNT) {
    throw new RangeError(`Unique index must be 0 to ${UNIQUE_PERF_COUNT - 1}.`);
  }
  return slotBase(slot) + UNIQUE_PERF_OFF + index * 4;
}

/** Preserve the raw dword on read, including values other than 0/1. */
export function getUniquePerfValue(data: Uint8Array, slot: number, index: number): number {
  return dataView(data).getUint32(uniquePerfOffset(slot, index), true);
}

/** Changes only the selected per-car dword, not the event record or purchase bookkeeping. */
export function setUniquePerfFlag(data: Uint8Array, slot: number, index: number, on: boolean): Uint8Array {
  const out = data.slice();
  dataView(out).setUint32(uniquePerfOffset(slot, index), on ? 1 : 0, true);
  return out;
}

/**
 * Reads one part flag.
 * @param data Save bytes.
 * @param slot Slot index.
 * @param index Part index.
 * @returns True when the part is installed.
 */
export function getPerfFlag(data: Uint8Array, slot: number, index: number): boolean {
  return data[perfOffset(slot, index)] !== 0;
}

/**
 * Returns a copy with one part flag changed.
 * @param data Save bytes. Not mutated.
 * @param slot Slot index.
 * @param index Part index.
 * @param on New state.
 * @returns A new array.
 */
export function setPerfFlag(data: Uint8Array, slot: number, index: number, on: boolean): Uint8Array {
  const out = data.slice();
  out[perfOffset(slot, index)] = on ? 1 : 0;
  return out;
}

/**
 * Returns a copy with several part flags set to the same state.
 * @param data Save bytes. Not mutated.
 * @param slot Slot index.
 * @param indices Part indices to change.
 * @param on New state.
 * @returns A new array.
 */
export function setPerfFlags(data: Uint8Array, slot: number, indices: number[], on: boolean): Uint8Array {
  const out = data.slice();
  for (const index of indices) {
    out[perfOffset(slot, index)] = on ? 1 : 0;
  }
  return out;
}

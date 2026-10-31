import { PERF_PARTS } from '../data/perf-parts.js';
import { slotBase, PERF_OFF } from './layout.js';

/** Number of performance part flags. */
export const PERF_COUNT = PERF_PARTS.length;

/**
 * Slot-relative address of one part flag.
 * @param slot Slot index.
 * @param index Part index, 0 to {@link PERF_COUNT} - 1.
 * @returns Absolute byte offset.
 * @throws RangeError when the part index is out of range.
 */
function perfOffset(slot: number, index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= PERF_COUNT) {
    throw new RangeError(`Part index must be 0 to ${PERF_COUNT - 1}.`);
  }
  return slotBase(slot) + PERF_OFF + index;
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

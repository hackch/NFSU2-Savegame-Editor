import { bytesToHex, dataView, CAR_TYPE_HASH_REL } from './layout.js';

/** One slot-relative block of donor car bytes, positioned at its absolute save offset. */
export interface DonorBlock {
  /** Absolute save offset of the block. */
  off: number;
  /** Block contents. */
  bytes: Uint8Array;
}

/** A car that can be written into a slot. */
export interface Donor {
  /** Position in the donor list. */
  id: number;
  /** Display name. */
  name: string;
  /** Upper-case hex model key, 8 digits. */
  key: string;
  /** Car type hash from the first block, distinct from the shared model key. */
  hash: number;
  /** The three slot blocks, in save order. */
  blocks: DonorBlock[];
}

/** Absolute offsets of the three per-slot blocks in `car-donors.json`. */
export const SLOT_BLOCK_OFFSETS = [0x5870, 0x5950, 0x5b20];
/** Offset of the block whose tail holds the model key. */
export const KEY_BLOCK_OFF = 0x5b20;

/**
 * Converts the space-separated hex string used by `car-donors.json` to bytes.
 * @param hex Hex bytes such as `"0A FF"`.
 * @returns The decoded bytes.
 */
function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.trim().split(/\s+/), (h) => parseInt(h, 16));
}

/**
 * Builds donors from the raw `car-donors.json` object (name to block list).
 * @param raw Parsed JSON.
 * @returns One donor per entry.
 * @throws Error when a donor lacks one of the three slot blocks.
 */
export function parseCarDatabase(raw: Record<string, { off: number; hex: string }[]>): Donor[] {
  return Object.entries(raw).map(([name, blocks], id) => {
    const slotBlocks: DonorBlock[] = blocks
      .filter((b) => SLOT_BLOCK_OFFSETS.includes(b.off))
      .map((b) => ({ off: b.off, bytes: hexToBytes(b.hex) }));
    if (slotBlocks.length !== SLOT_BLOCK_OFFSETS.length) {
      throw new Error(`Donor "${name}" is missing slot blocks.`);
    }
    const keyBlock = slotBlocks.find((b) => b.off === KEY_BLOCK_OFF) as DonorBlock;
    const carBlock = slotBlocks.find((b) => b.off === SLOT_BLOCK_OFFSETS[0]) as DonorBlock;
    if (carBlock.bytes.length < CAR_TYPE_HASH_REL + 4) {
      throw new Error(`Donor "${name}" is missing its car type hash.`);
    }
    return {
      id,
      name: name.trim(),
      key: bytesToHex(keyBlock.bytes.subarray(keyBlock.bytes.length - 4)),
      hash: dataView(carBlock.bytes).getUint32(CAR_TYPE_HASH_REL, true),
      blocks: slotBlocks,
    };
  });
}

/**
 * Indexes donors by car type hash. Variants of the same car (sponsor and intro versions) share a hash;
 * the first one listed wins.
 * @param donors Donor list.
 * @returns Map from car type hash to donor. The empty hash 0 is skipped.
 */
export function buildCarIndex(donors: Donor[]): Map<number, Donor> {
  const index = new Map<number, Donor>();
  for (const donor of donors) {
    if (donor.hash === 0 || index.has(donor.hash)) continue;
    index.set(donor.hash, donor);
  }
  return index;
}

/**
 * Looks up the donor for a car type hash.
 * @param index Index from {@link buildCarIndex}.
 * @param hash Car type hash.
 * @returns The matching donor, or `null` when the key is unknown.
 */
export function identifyCar(index: Map<number, Donor>, hash: number): Donor | null {
  return index.get(hash) ?? null;
}

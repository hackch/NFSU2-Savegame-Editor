// Donor cars from the GabriLex NFSU2 profile tool (car-donors.json).
// Each donor carries the three per-slot blocks; the save-wide blocks are ignored.
export const SLOT_BLOCK_OFFSETS = [0x5870, 0x5950, 0x5b20];
export const KEY_BLOCK_OFF = 0x5b20;

function hexToBytes(hex) {
  return Uint8Array.from(hex.trim().split(/\s+/), (h) => parseInt(h, 16));
}

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export function parseCarDatabase(raw) {
  return Object.entries(raw).map(([name, blocks], id) => {
    const slotBlocks = blocks
      .filter((b) => SLOT_BLOCK_OFFSETS.includes(b.off))
      .map((b) => ({ off: b.off, bytes: hexToBytes(b.hex) }));
    if (slotBlocks.length !== SLOT_BLOCK_OFFSETS.length) {
      throw new Error(`Donor "${name}" is missing slot blocks.`);
    }
    const keyBlock = slotBlocks.find((b) => b.off === KEY_BLOCK_OFF);
    return {
      id,
      name: name.trim(),
      key: bytesToHex(keyBlock.bytes.subarray(keyBlock.bytes.length - 4)),
      blocks: slotBlocks,
    };
  });
}

// Several donors share a key (base car, sponsor and intro versions). The first one listed wins.
export function buildCarIndex(donors) {
  const index = new Map();
  for (const donor of donors) {
    if (donor.key === '00000000' || index.has(donor.key)) continue;
    index.set(donor.key, donor);
  }
  return index;
}

export function identifyCar(index, key) {
  return index.get(key) || null;
}

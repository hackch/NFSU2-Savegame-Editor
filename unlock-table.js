// Per-slot unlock table written by NFSU2-ProfileCreator when a category or "unlock all" is checked.
// Ranges are inclusive offsets relative to the start of a car slot. A byte of 0xFF means unlocked.
// Category split comes from diffing creator saves that unlock one category each against a baseline.
// Which byte is which individual part is not mapped yet.
export const UNLOCK_CATEGORIES = {
  bodyParts: [
    [0x462, 0x475],
    [0x47e, 0x485],
    [0x59a, 0x5fd],
    [0x61e, 0x64d],
    [0x696, 0x6b1],
    [0x6b6, 0x6bd],
    [0x6c2, 0x6c9],
  ],
  specialities: [
    [0x486, 0x495],
    [0x49a, 0x49d],
    [0x4a2, 0x4ad],
    [0x4b6, 0x4bd],
    [0x5fe, 0x61d],
    [0x7da, 0x7e1],
  ],
  graphics: [[0x4ce, 0x53d]],
  performance: [[0x586, 0x58d]],
};

function expandRanges(ranges) {
  const offsets = [];
  for (const [start, end] of ranges) {
    for (let rel = start; rel <= end; rel++) offsets.push(rel);
  }
  return offsets;
}

export const UNLOCK_CATEGORY_OFFSETS = Object.fromEntries(
  Object.entries(UNLOCK_CATEGORIES).map(([name, ranges]) => [name, expandRanges(ranges)]),
);

export const UNLOCK_OFFSETS = Object.values(UNLOCK_CATEGORY_OFFSETS).flat().sort((a, b) => a - b);

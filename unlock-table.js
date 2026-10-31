// Per-slot unlock table written by NFSU2-ProfileCreator when "unlock all" is checked.
// Ranges are inclusive offsets relative to the start of a car slot. A byte of 0xFF means unlocked.
// Found by diffing two profiles from the creator that differ only in that option.
// Which byte is which part or colour is not mapped yet.
export const UNLOCK_RANGES = [
  [0x462, 0x475],
  [0x47e, 0x495],
  [0x49a, 0x49d],
  [0x4a2, 0x4ad],
  [0x4b6, 0x4bd],
  [0x4ce, 0x53d],
  [0x586, 0x58d],
  [0x59a, 0x64d],
  [0x696, 0x6b1],
  [0x6b6, 0x6bd],
  [0x6c2, 0x6c9],
  [0x7da, 0x7e1],
];

export const UNLOCK_OFFSETS = UNLOCK_RANGES.flatMap(([start, end]) => {
  const offsets = [];
  for (let rel = start; rel <= end; rel++) offsets.push(rel);
  return offsets;
});

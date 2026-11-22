#!/usr/bin/env node
/**
 * Creates a separate GLOBALB.BUN variant with a wider final-drive range.
 *
 * Usage:
 *   node scripts/patch-final-drive.mjs <input.bun> <output.bun> --min 3.0
 *   node scripts/patch-final-drive.mjs <input.bun> <output.bun> --min 2.0
 *
 * The input is never modified. The output is a complete copy with only the
 * player-car upgraded final-drive bound and param-9 tuning-record bounds changed.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [input, output, flag, minText] = process.argv.slice(2);
if (!input || !output || flag !== '--min' || !['3.0', '2.0'].includes(minText)) {
  console.error('Usage: node scripts/patch-final-drive.mjs <input.bun> <output.bun> --min 3.0|2.0');
  process.exit(2);
}
const target = Number(minText);
const bytes = new Uint8Array(readFileSync(input));
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const chunks = new Map();
function walk(start, end) {
  let offset = start;
  while (offset + 8 <= end) {
    const id = view.getUint32(offset, true);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > end) break;
    if (!chunks.has(id)) chunks.set(id, []);
    chunks.get(id).push({ offset: body, size });
    if (id & 0x80000000) walk(body, body + size);
    offset = body + size;
  }
}
walk(0, bytes.length);

const carChunks = chunks.get(0x34600) ?? [];
const tuningChunks = chunks.get(0x34a1a) ?? [];
if (!carChunks.length || tuningChunks.length < 2) {
  throw new Error('Required GLOBALB.BUN car/tuning chunks were not found.');
}
const carChunk = carChunks[0];
let carStart = carChunk.offset;
while (carStart < carChunk.offset + 16 && bytes[carStart] === 0x11) carStart++;
const carCount = Math.floor((carChunk.offset + carChunk.size - carStart) / 0x890);
if (carCount < 31) throw new Error(`Expected at least 31 player-car records; found ${carCount}.`);

const cars = [];
let highestBaseline = 0;
for (let i = 0; i < 31; i++) {
  const base = carStart + i * 0x890;
  let name = '';
  for (let k = 0; k < 0x20 && bytes[base + k]; k++) name += String.fromCharCode(bytes[base + k]);
  if (!name) throw new Error(`Player car record ${i} has no name; refusing to patch.`);
  const phys = base + 0x110;
  const stock = view.getFloat32(phys + 0x1b8, true);
  const upgraded = view.getFloat32(phys + 0x3d8, true);
  if (!Number.isFinite(stock) || !Number.isFinite(upgraded) || stock <= target || upgraded <= target) {
    throw new Error(`Unexpected final-drive baseline for ${name}: stock=${stock}, upgraded=${upgraded}.`);
  }
  highestBaseline = Math.max(highestBaseline, stock, upgraded);
  cars.push({ name, upgradedOffset: phys + 0x3d8, stock, upgraded });
}
const margin = 0.05;
const expansion = Math.fround(highestBaseline - target + margin);

// Update the per-car lower absolute bound. Preserve stock final drive.
for (const car of cars) view.setFloat32(car.upgradedOffset, target, true);

// The game stores duplicate tuning tables in this BUN. Patch both copies.
let foundLevel1 = 0, foundLevel2 = 0, foundLevel3 = 0;
for (const chunk of tuningChunks) {
  for (let offset = chunk.offset; offset + 0x18 <= chunk.offset + chunk.size; offset += 0x18) {
    const item = view.getUint32(offset, true);
    const param = bytes[offset + 5];
    const type = bytes[offset + 6];
    if (param !== 9) continue;
    if (item === 8 && type === 1) {
      view.setFloat32(offset + 8, -expansion, true);
      foundLevel1++;
    } else if (item === 9 && type === 1) {
      view.setFloat32(offset + 8, -expansion, true);
      foundLevel2++;
    } else if (item === 11 && type === 0) {
      view.setFloat32(offset + 12, expansion, true);
      foundLevel3++;
    }
  }
}
const copies = tuningChunks.length;
if (foundLevel1 < copies || foundLevel2 < copies || foundLevel3 < copies) {
  throw new Error(`Incomplete tuning-record match: item8=${foundLevel1}, item9=${foundLevel2}, item11=${foundLevel3}, copies=${copies}.`);
}
writeFileSync(output, bytes);
console.log(JSON.stringify({
  input, output, targetMinimum: target, carsPatched: cars.length,
  maxOriginalBaseline: highestBaseline, expansion,
  tuningRecordMatches: { differential: foundLevel1, lsd: foundLevel2, sixSpeed: foundLevel3 },
  inputBytes: bytes.length, outputBytes: bytes.length,
  note: 'Input was read only. Back up the game original before installing the output.'
}, null, 2));

// Run after npm run build. This is a conservative evidence map, not a save-format decoder.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  HEADER_SIZE, PROFILE_SIZE, SLOT_COUNT, SLOT_STRIDE, SLOT_RECORD_REL, slotBase,
  CAR_TYPE_HASH_REL, VISUAL_OFF, VISUAL_COUNT, UNIQUE_PERF_OFF, PERF_OFF,
  PERF_PURCHASE_OFF, SLOT_LOCK_REL, SLOT_BOUGHT_REL, MONEY_OFF,
  NAME_OFF, NAME_FIELD_SIZE,
} from '../dist/model/layout.js';
import { TUNING_OFF, SETUP_COUNT, SETUP_SIZE } from '../dist/model/dyno.js';
import { PERF_COUNT, UNIQUE_PERF_COUNT } from '../dist/model/perf.js';
import { checkSave, verifyChecksums } from '../dist/model/save-file.js';

const root = new URL('../', import.meta.url);
const save = new Uint8Array(readFileSync(new URL('testfile/treav0r', root)));
assert.equal(save.length, PROFILE_SIZE);
assert.equal(checkSave(save).ok, true);
assert.deepEqual(verifyChecksums(save), { blockA: true, blockB: true, header: true });
const view = new DataView(save.buffer, save.byteOffset, save.byteLength);
const lenA = view.getUint32(8, true);
const lenB = view.getUint32(12, true);
const eventCount = view.getUint32(0xa179, true);
const eventStart = 0xa17d;
const eventCapacity = 384;
const eventEnd = eventStart + eventCount * 8;
assert.ok(eventCount <= eventCapacity, 'Event count exceeds the native fixed array.');
assert.equal(eventStart + eventCapacity * 8, 0xad7d);

const states = new Uint8Array(save.length);
const labels = [];
function mark(start, size, state, label) {
  assert.ok(Number.isInteger(start) && Number.isInteger(size) && size > 0);
  assert.ok(start >= 0 && start + size <= save.length, `${label} is outside the save.`);
  for (let i = start; i < start + size; i++) {
    assert.ok(states[i] < state, `${label} overlaps another range at the same evidence level.`);
    states[i] = state;
  }
  labels.push({ start, end: start + size, state, label });
}

// Native serializers establish these internal boundaries, not just the outer block length.
const blocks = [
  [0x0000, 0x001c, 'Header'],
  [0x001c, 0x0024, 'Compatibility descriptor'],
  [0x0024, 0x04a8, 'Stock catalogue and active count'],
  [0x04a8, 0x5868, '20 generic configurations'],
  [0x5868, 0x8022, 'Five career garage records'],
  [0x8022, 0x8026, 'Garage-record count'],
  [0x8026, 0x995e, 'Six special configurations'],
  [0x995e, 0x9962, 'Special-configuration count'],
  [0x9962, 0xa16a, 'Eight stage records'],
  [0xa16a, 0xae9a, 'Career scalars and 384 event records'],
  [0xae9a, 0xc2a3, '256 SMS inbox records and controls'],
  [0xc2a3, 0xc447, 'Career tail'],
  [0xc447, 0xd225, 'Profile copy spans'],
  [0xd225, 0xd245, 'Driver name'],
  [0xd245, 0xd278, 'Auxiliary tail object'],
  [0xd278, 0xd6b6, 'Six identity-matched runtime-state records'],
];
let boundary = 0;
for (const [start, end, label] of blocks) {
  assert.equal(start, boundary, `${label} leaves a structural gap or overlap.`);
  mark(start, end - start, 1, label);
  boundary = end;
}
assert.equal(boundary, save.length);
mark(0, HEADER_SIZE, 2, 'Magic, uint32 file length, block lengths and three CRCs');
assert.equal(view.getUint32(4, true), save.length);
assert.equal(lenA, 8);
assert.equal(view.getUint32(HEADER_SIZE, true), 0x10d);
assert.equal(view.getUint32(HEADER_SIZE + 4, true), lenB);
mark(HEADER_SIZE, lenA, 2, 'Compatibility tag 0x10D and body size');

const traceEnd = 0x1000;
const stockBase = HEADER_SIZE + lenA;
const stockCount = 48;
const stockStride = 0x18;
const stockCountOff = stockBase + stockCount * stockStride;
const configBase = stockCountOff + 4;
const configStride = 0x430;
assert.equal(stockCountOff, 0x4a4);
assert.equal(configBase + 20 * configStride, slotBase(0) + SLOT_RECORD_REL);
for (let i = 0; i < stockCount; i++) {
  const base = stockBase + i * stockStride;
  for (const [rel, label] of [
    [4, 'STOCK_<name> handle'],
    [0xc, 'enumeration-enabled flag'],
    [0x10, 'record-type mask (stock = 1)'],
    [0x14, 'BUN car index (-1 when unassigned)'],
  ]) mark(base + rel, 4, 2, `Stock ${i + 1}: ${label}`);
}
mark(stockCountOff, 4, 2, 'Active stock catalogue count');
assert.equal(view.getUint32(stockCountOff, true), 31);
for (let i = 0; i < 31; i++) {
  assert.equal(view.getInt32(stockBase + i * stockStride + 0x14, true), i);
}
function markConfiguration(base, prefix, type) {
  // Generic serialized records are eight bytes ahead of the editor-relative garage layout.
  for (const [rel, size, label] of [
    [4, 4, 'lookup handle'],
    [0xc, 4, 'enumeration-enabled flag'],
    [0x10, 4, `record-type mask (${type})`],
    [0x14, 4, 'configuration initialized marker'],
    [CAR_TYPE_HASH_REL + 8, 4, 'car identity'],
    [VISUAL_OFF + 8, VISUAL_COUNT * 4, '170 visual hashes'],
    [UNIQUE_PERF_OFF + 8, UNIQUE_PERF_COUNT * 4, 'nine unique flags'],
    [PERF_OFF + 8, PERF_COUNT, '68 installed-item positions'],
    [TUNING_OFF + 8, SETUP_COUNT * SETUP_SIZE, 'five dyno setups'],
  ]) {
    mark(base + rel, size, 2, `${prefix}: ${label}`);
  }
}
for (let i = 0; i < 20; i++) {
  markConfiguration(configBase + i * configStride, `Generic ${i + 1}`, 'generic = 2');
}
for (let slot = 0; slot < SLOT_COUNT; slot++) {
  const base = slotBase(slot);
  const prefix = `Car ${slot + 1}: `;
  for (const [rel, size, label] of [
    [SLOT_RECORD_REL + 4, 4, 'CAREER_SLOT handle'],
    [SLOT_RECORD_REL + 0xc, 4, 'enumeration-enabled flag'],
    [SLOT_RECORD_REL + 0x10, 4, 'record-type mask (career = 4)'],
    [SLOT_RECORD_REL + 0x14, 4, 'configuration initialized marker'],
    [CAR_TYPE_HASH_REL, 4, 'car identity'],
    [VISUAL_OFF, VISUAL_COUNT * 4, '170 visual hashes'],
    [UNIQUE_PERF_OFF, UNIQUE_PERF_COUNT * 4, 'nine unique flags'],
    [PERF_OFF, PERF_COUNT, '68 installed-item positions'],
    [TUNING_OFF, SETUP_COUNT * SETUP_SIZE, 'five dyno setups'],
    [SLOT_LOCK_REL, 1, 'lock flag'],
    [SLOT_BOUGHT_REL, 1, 'bought flag'],
    // The ninth ownership byte's visual-purchase semantics remain unverified.
    [PERF_PURCHASE_OFF, 8, 'ownership bits for IDs 0-63'],
    [0x6be, 4, 'ordinary purchase-price accumulator'],
  ]) mark(base + rel, size, 2, prefix + label);
}
assert.equal(slotBase(SLOT_COUNT - 1) + SLOT_RECORD_REL + SLOT_STRIDE, 0x8022);
mark(0x8022, 4, 2, 'Garage-record count, not the current-stage field');
for (let i = 0; i < 6; i++) {
  markConfiguration(0x8026 + i * 0x434, `Special ${i + 1}`, 'special = 16');
}
mark(0x995e, 4, 2, 'Special-configuration count');
for (let i = 0; i < 8; i++) {
  const base = 0x9962 + i * 0x101;
  mark(base, 35 * 4, 2, `Stage ${i}: completed ordinary-race hashes`);
  mark(base + 0x8c, 4 * 4, 2, `Stage ${i}: completed URL hashes`);
  mark(base + 0x9c, 10 * 4, 2, `Stage ${i}: completed sponsor-race hashes`);
  mark(base + 0xdc, 4, 2, `Stage ${i + 1}: outcome counter`);
  mark(base + 0xe8, 20, 2, `Stage ${i + 1}: five BUN event-reference name hashes`);
  mark(base + 0xfc, 1, 2, `Stage ${i}: completion flag`);
  mark(base + 0xfd, 4, 2, `Stage ${i + 1}: sign-extended BUN table record ID`);
}
mark(MONEY_OFF, 4, 2, 'Career money');
mark(0xa175, 4, 2, 'Current career-stage index, uint32 LE');
mark(0xa179, 4, 2, 'Event entry count');
for (let i = 0; i < eventCapacity; i++) {
  mark(eventStart + i * 8, 4, 2, 'Event-name hash');
  mark(eventStart + i * 8 + 6, 1, 2, 'Event status byte');
}
for (let i = 0; i < 256; i++) {
  mark(0xae9a + i * 20, 4, 2, 'SMS definition-name hash');
  mark(0xae9a + i * 20 + 4, 1, 2, 'SMS read flag');
}
mark(0xc29a, 4, 2, 'SMS inbox entry count');
mark(0xc29e, 4, 2, 'SMS unread/actionable count');
mark(NAME_OFF, NAME_FIELD_SIZE, 2, 'Driver name field');
mark(0xd245, 8, 2, 'Auxiliary object reserved dwords: native writer always emits zero');

const totals = [0, 0, 0];
for (const state of states) totals[state]++;
assert.equal(totals.reduce((a, b) => a + b), save.length);
assert.equal(totals[0], 0, 'Every byte must belong to a traced internal serializer span.');
const firstPageTotals = [0, 0, 0];
for (const state of states.subarray(0, traceEnd)) firstPageTotals[state]++;
assert.deepEqual(firstPageTotals, [0, 562, 3534]);
const hex = (value) => `0x${value.toString(16).toUpperCase().padStart(4, '0')}`;
const pct = (value) => (100 * value / save.length).toFixed(2);
const number = (value) => value.toLocaleString('en-US');
const colors = ['#334155', '#f59e0b', '#10b981'];
const names = ['Unlocated payload', 'Located, incomplete semantics', 'Deciphered fields'];
const escape = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const columns = 32;
const cellBytes = 64;
const rowBytes = columns * cellBytes;
const cellWidth = 24;
const cellHeight = 20;
const rows = Math.ceil(save.length / rowBytes);
const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="920" height="${245 + rows * cellHeight}" viewBox="0 0 920 ${245 + rows * cellHeight}" role="img" aria-labelledby="title desc">`,
  '<title id="title">NFSU2 career save discovery grid</title>',
  `<desc id="desc">${number(save.length)} bytes. ${names.map((name, i) => `${name}: ${number(totals[i])} bytes (${pct(totals[i])}%)`).join('; ')}. Read left to right, top to bottom; each cell is 64 bytes. Mixed cells show exact byte proportions.</desc>`,
  '<rect width="100%" height="100%" fill="#0f172a"/>',
  '<g font-family="sans-serif" fill="#f8fafc">',
  '<text x="24" y="32" font-size="22" font-weight="bold">How much of the career save have we deciphered?</text>',
  `<text x="24" y="58" font-size="14">${number(save.length)} bytes / ${hex(save.length)} / ${(save.length / 1024).toFixed(2)} KiB | treav0r baseline</text>`,
  '<text x="24" y="80" font-size="13">Deciphered means field meaning + encoding known, not exhaustive in-game validation.</text>',
];
for (let i = 0; i < 3; i++) {
  svg.push(`<rect x="24" y="${98 + i * 23}" width="14" height="14" fill="${colors[i]}"/>`,
    `<text x="46" y="${110 + i * 23}" font-size="13">${names[i]}: ${number(totals[i])} bytes (${pct(totals[i])}%)</text>`);
}
svg.push('<text x="24" y="184" font-size="13">32 cells per row x 64 bytes = 2,048 bytes per row. Mixed colours are byte proportions.</text>');
let renderedBytes = 0;
for (let cell = 0; cell * cellBytes < save.length; cell++) {
  const start = cell * cellBytes;
  const end = Math.min(start + cellBytes, save.length);
  const counts = [0, 0, 0];
  for (let i = start; i < end; i++) counts[states[i]]++;
  renderedBytes += counts.reduce((a, b) => a + b);
  const row = Math.floor(cell / columns);
  const x = 100 + (cell % columns) * cellWidth;
  const y = 202 + row * cellHeight;
  if (cell % columns === 0) {
    svg.push(`<text x="24" y="${y + 13}" font-family="monospace" font-size="12">${hex(start)}</text>`);
  }
  const detail = labels.filter((range) => range.start < end && range.end > start);
  svg.push(`<g><title>${hex(start)}-${hex(end - 1)}: ${counts.map((n, i) => `${n} ${names[i]}`).join(', ')}${detail.length ? '; ' + escape([...new Set(detail.map((r) => r.label))].join('; ')) : ''}</title>`);
  let offset = 0;
  for (let state = 0; state < 3; state++) {
    const width = counts[state] / cellBytes * (cellWidth - 2);
    if (width > 0) svg.push(`<rect x="${x + offset}" y="${y}" width="${width}" height="${cellHeight - 2}" fill="${colors[state]}"/>`);
    offset += width;
  }
  svg.push('</g>');
}
assert.equal(renderedBytes, save.length, 'Grid must cover every byte exactly once.');
svg.push(`<text x="24" y="${228 + rows * cellHeight}" font-size="12">Last cell: ${save.length % cellBytes || cellBytes} real bytes; blank remainder is outside the file. No zero-byte/padding guesses.</text>`,
  '</g></svg>');
writeFileSync(new URL('save-coverage.svg', root), svg.join('\n') + '\n');
console.log(JSON.stringify({
  size: save.length, blockA: { start: HEADER_SIZE, size: lenA },
  blockB: { start: HEADER_SIZE + lenA, size: lenB },
  eventCount, eventEnd: hex(eventEnd), eventCapacity, eventArrayEnd: hex(eventStart + eventCapacity * 8),
  first4KiB: { unlocated: firstPageTotals[0], locatedIncomplete: firstPageTotals[1], deciphered: firstPageTotals[2] },
  coverage: names.map((name, i) => ({ name, bytes: totals[i], percent: pct(totals[i]) })),
  locatedIncludingDeciphered: { bytes: totals[1] + totals[2], percent: pct(totals[1] + totals[2]) },
  blocks: blocks.map(([start, end, label]) => ({
    label, start: hex(start), end: hex(end), size: end - start,
    deciphered: states.subarray(start, end).filter((state) => state === 2).length,
  })),
}, null, 2));

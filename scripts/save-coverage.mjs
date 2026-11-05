// Run after npm run build. This is a conservative evidence map, not a save-format decoder.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  HEADER_SIZE, PROFILE_SIZE, SLOT_COUNT, SLOT_STRIDE, SLOT_RECORD_REL, slotBase,
  CAR_TYPE_HASH_REL, VISUAL_OFF, VISUAL_COUNT, UNIQUE_PERF_OFF, PERF_OFF,
  PERF_PURCHASE_OFF, SLOT_LOCK_REL, SLOT_BOUGHT_REL, MONEY_OFF, GARAGE_CAR_COUNT,
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
const eventEnd = eventStart + eventCount * 8;
assert.ok(eventEnd <= NAME_OFF, 'Observed event entries must not overlap the driver name.');

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

// 0: unlocated payload; 1: located structure, semantics incomplete; 2: deciphered field.
mark(0, HEADER_SIZE, 1, '20CM header');
mark(HEADER_SIZE, lenA, 1, 'Block A payload (meaning unknown)');
mark(0, 6, 2, 'Magic and uint16 file length');
mark(8, 20, 2, 'Block lengths and three CRCs');
for (let slot = 0; slot < SLOT_COUNT; slot++) {
  const base = slotBase(slot);
  const prefix = `Car ${slot + 1}: `;
  mark(base + SLOT_RECORD_REL, SLOT_STRIDE, 1, prefix + 'native record');
  for (const [rel, size, label] of [
    [SLOT_RECORD_REL + 4, 4, 'CAREER_SLOT handle'],
    [CAR_TYPE_HASH_REL, 4, 'car identity'],
    [VISUAL_OFF, VISUAL_COUNT * 4, '170 visual hashes'],
    [UNIQUE_PERF_OFF, UNIQUE_PERF_COUNT * 4, 'nine unique flags'],
    [PERF_OFF, PERF_COUNT, '68 installed-item positions'],
    [TUNING_OFF, SETUP_COUNT * SETUP_SIZE, 'five dyno setups'],
    [SLOT_LOCK_REL, 1, 'lock flag'],
    [SLOT_BOUGHT_REL, 1, 'bought flag'],
    // The ninth ownership byte's visual-purchase semantics remain unverified.
    [PERF_PURCHASE_OFF, 8, 'ownership bits for IDs 0-63'],
  ]) mark(base + rel, size, 2, prefix + label);
}
mark(MONEY_OFF, 4, 2, 'Career money');
mark(GARAGE_CAR_COUNT, 1, 2, 'Garage count');
mark(0xa179, 4, 2, 'Event entry count');
mark(eventStart, eventCount * 8, 1, 'Observed event entries (8-byte stride)');
for (let i = 0; i < eventCount; i++) {
  mark(eventStart + i * 8 + 6, 1, 2, 'Event status byte');
}
mark(NAME_OFF, NAME_FIELD_SIZE, 2, 'Driver name field');

const totals = [0, 0, 0];
for (const state of states) totals[state]++;
assert.equal(totals.reduce((a, b) => a + b), save.length);
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
  const detail = labels.filter((range) => range.start < end && range.end > start && range.state === 2);
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
  eventCount, eventEnd: hex(eventEnd),
  coverage: names.map((name, i) => ({ name, bytes: totals[i], percent: pct(totals[i]) })),
  locatedIncludingDeciphered: { bytes: totals[1] + totals[2], percent: pct(totals[1] + totals[2]) },
}, null, 2));

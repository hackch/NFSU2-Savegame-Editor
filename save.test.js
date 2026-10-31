import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { nfsu2Crc } from './crc32.js';
import { PERF_PARTS, PERF_CATEGORIES } from './perf-parts.js';
import {
  checkSave, verifyChecksums, recalculateChecksums, getMoney, setMoney,
  getName, setName, validateName, isSlotUsed, getPerfFlag, setPerfFlag,
  setPerfFlags, swapSlots, getCarKey, setSlotCar, SLOT_BASE, SLOT_STRIDE, PERF_OFF, PERF_COUNT, MONEY_OFF,
} from './save.js';
import { parseCarDatabase, buildCarIndex, identifyCar } from './cars.js';

const FIXTURE = fileURLToPath(new URL('./testfile/treav0r', import.meta.url));
const hasFixture = existsSync(FIXTURE);
const load = () => new Uint8Array(readFileSync(FIXTURE));

test('CRC of inputs shorter than 4 bytes is 0', () => {
  assert.equal(nfsu2Crc(new Uint8Array([1, 2, 3])), 0);
});

test('part table has 68 entries with verified indices 15 and 16', () => {
  assert.equal(PERF_PARTS.length, PERF_COUNT);
  assert.equal(PERF_PARTS[15].key, 'EN_MUFFLER');
  assert.equal(PERF_PARTS[16].key, 'EN_COLD_AIR_INTAKE_SYSTEM');
  const verified = PERF_PARTS.filter((p) => p.verified).map((p) => p.index);
  assert.deepEqual(verified, [15, 16]);
});

test('every part index belongs to exactly one category', () => {
  const seen = PERF_CATEGORIES.flatMap((c) => c.indices).sort((a, b) => a - b);
  assert.deepEqual(seen, PERF_PARTS.map((p) => p.index));
});

test('name validation', () => {
  assert.equal(validateName(''), 'Name cannot be empty.');
  assert.equal(validateName('x'.repeat(32)) !== null, true);
  assert.equal(validateName('x'.repeat(31)), null);
  assert.equal(validateName('caf\u00e9'), null);
  assert.notEqual(validateName('\u20ac'), null);
});

test('money range is enforced', () => {
  const data = new Uint8Array(0xd300);
  assert.throws(() => setMoney(data, -1), RangeError);
  assert.throws(() => setMoney(data, 0x80000000), RangeError);
  assert.throws(() => setMoney(data, 1.5), RangeError);
  assert.equal(getMoney(setMoney(data, 0x7fffffff)), 0x7fffffff);
});

test('setMoney and setName never mutate their input', () => {
  const data = new Uint8Array(0xd300);
  setMoney(data, 5);
  setName(data, 'abc');
  assert.equal(getMoney(data), 0);
  assert.equal(getName(data), '');
});

test('perf flag only changes its own byte', () => {
  const data = new Uint8Array(0xd300);
  const out = setPerfFlag(data, 0, 15, true);
  const diffs = [];
  for (let i = 0; i < data.length; i++) if (out[i] !== data[i]) diffs.push(i);
  assert.deepEqual(diffs, [SLOT_BASE + PERF_OFF + 15]);
  assert.equal(getPerfFlag(out, 0, 15), true);
  assert.equal(getPerfFlag(out, 0, 16), false);
});

test('setPerfFlags sets many indices at once', () => {
  const data = new Uint8Array(0xd300);
  const out = setPerfFlags(data, 2, [0, 15, 16], true);
  assert.equal(getPerfFlag(out, 2, 0), true);
  assert.equal(getPerfFlag(out, 2, 15), true);
  assert.equal(getPerfFlag(out, 2, 16), true);
  const off = setPerfFlags(out, 2, [0, 15, 16], false);
  assert.equal(getPerfFlag(off, 2, 15), false);
});

test('swapping slots twice restores the original bytes', () => {
  const data = new Uint8Array(0xd300);
  data.forEach((_, i) => { data[i] = i & 0xff; });
  const once = swapSlots(data, 0, 3);
  assert.notDeepEqual(once, data);
  assert.deepEqual(swapSlots(once, 0, 3), data);
  assert.equal(once[SLOT_BASE], data[SLOT_BASE + 3 * SLOT_STRIDE]);
});

test('recalculated checksums verify on synthetic data', () => {
  const data = new Uint8Array(0x1c + 8 + 16);
  const v = new DataView(data.buffer);
  data.set([0x32, 0x30, 0x43, 0x4d]);
  v.setUint32(0x08, 8, true);
  v.setUint32(0x0c, 16, true);
  v.setUint16(0x04, data.length & 0xffff, true);
  const fixed = recalculateChecksums(data);
  assert.equal(checkSave(fixed).ok, true);
  assert.deepEqual(verifyChecksums(fixed), { blockA: true, blockB: true, header: true });
});

test('checkSave rejects bad magic and bad lengths', () => {
  assert.equal(checkSave(new Uint8Array(4)).ok, false);
  const bad = new Uint8Array(0x30);
  bad.set([0x32, 0x30, 0x43, 0x4d]);
  assert.equal(checkSave(bad).ok, false);
});

test('fixture: checksums verify and recalculation is a no-op', { skip: !hasFixture && 'testfile/treav0r missing' }, () => {
  const data = load();
  assert.equal(checkSave(data).ok, true);
  assert.deepEqual(verifyChecksums(data), { blockA: true, blockB: true, header: true });
  assert.deepEqual(recalculateChecksums(data), data);
});

test('fixture: money and name edits recalculate to valid checksums', { skip: !hasFixture && 'testfile/treav0r missing' }, () => {
  const edited = recalculateChecksums(setName(setMoney(load(), 1337420), 'treav0r'));
  assert.equal(getMoney(edited), 1337420);
  assert.equal(getName(edited), 'treav0r');
  assert.equal(edited[MONEY_OFF], 1337420 & 0xff);
  assert.deepEqual(verifyChecksums(edited), { blockA: true, blockB: true, header: true });
});

test('fixture: slot usage reads without throwing', { skip: !hasFixture && 'testfile/treav0r missing' }, () => {
  const data = load();
  const used = [0, 1, 2, 3, 4].map((s) => isSlotUsed(data, s));
  assert.equal(used.length, 5);
});

const donorRaw = JSON.parse(readFileSync(fileURLToPath(new URL('./car-donors.json', import.meta.url)), 'utf8'));
const donors = parseCarDatabase(donorRaw);
const carIndex = buildCarIndex(donors);
const donorNamed = (name) => donors.find((d) => d.name === name);

test('every donor has three slot blocks whose key matches its key block tail', () => {
  assert.equal(donors.length, 49);
  for (const donor of donors) {
    assert.deepEqual(donor.blocks.map((b) => b.off), [0x5870, 0x5950, 0x5b20]);
    const tail = donor.blocks[2].bytes.slice(-4);
    assert.equal(donor.key, Array.from(tail, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase());
  }
});

test('fixture: model keys identify the known cars and the empty slot is unknown', { skip: !hasFixture && 'testfile/treav0r missing' }, () => {
  const data = load();
  assert.equal(identifyCar(carIndex, getCarKey(data, 0))?.name, 'Mazda RX8');
  assert.equal(identifyCar(carIndex, getCarKey(data, 1))?.name, 'Nissan 240SX');
  assert.equal(identifyCar(carIndex, getCarKey(data, 2))?.name, 'Cadillac Escalade (SUV)');
  assert.equal(identifyCar(carIndex, getCarKey(data, 3))?.name, 'Toyota Trueno AE86 (Corolla)');
  assert.equal(getCarKey(data, 4), '00000000');
  assert.equal(identifyCar(carIndex, getCarKey(data, 4)), null);
});

test('fixture: replacing a used slot changes its car, keeps tuning and recalculates cleanly', { skip: !hasFixture && 'testfile/treav0r missing' }, () => {
  const before = recalculateChecksums(setPerfFlag(setName(setMoney(load(), 1234), 'treav0r'), 0, 15, true));
  const target = donorNamed('Nissan 350Z');
  const after = recalculateChecksums(setSlotCar(before, 0, target));
  assert.equal(getCarKey(after, 0), target.key);
  assert.equal(identifyCar(carIndex, getCarKey(after, 0)).name, 'Nissan 350Z');
  assert.equal(isSlotUsed(after, 0), true);
  assert.equal(getPerfFlag(after, 0, 15), true);
  assert.equal(getMoney(after), 1234);
  assert.equal(getName(after), 'treav0r');
  assert.deepEqual(verifyChecksums(after), { blockA: true, blockB: true, header: true });
});

test('fixture: replacing a car only changes its slot and the checksum bytes', { skip: !hasFixture && 'testfile/treav0r missing' }, () => {
  const data = load();
  const out = setSlotCar(data, 1, donorNamed('Toyota Supra'));
  const diffs = [];
  for (let i = 0; i < data.length; i++) if (out[i] !== data[i]) diffs.push(i);
  const slotEnd = SLOT_BASE + SLOT_STRIDE * 2;
  const slotStart = SLOT_BASE + SLOT_STRIDE;
  assert.ok(diffs.length > 0);
  for (const i of diffs) {
    const inSlot = i >= slotStart && i < slotEnd;
    const inHeaderCrc = i >= 0x10 && i < 0x1c;
    assert.ok(inSlot || inHeaderCrc, `unexpected change at 0x${i.toString(16)}`);
  }
});

test('fixture: empty slot 5 becomes a used car with the copied header', { skip: !hasFixture && 'testfile/treav0r missing' }, () => {
  const data = load();
  const out = setSlotCar(data, 4, donorNamed('Mazda Miata MX5'));
  assert.equal(isSlotUsed(out, 4), true);
  assert.equal(identifyCar(carIndex, getCarKey(out, 4)).name, 'Mazda Miata MX5');
  const headerStart = SLOT_BASE + 4 * SLOT_STRIDE + 0x27c;
  assert.deepEqual(out.slice(headerStart, headerStart + 24), data.slice(SLOT_BASE + 0x27c, SLOT_BASE + 0x27c + 24));
});

test('setSlotCar refuses when there is no used slot to copy the header from', () => {
  const data = new Uint8Array(0xd300);
  assert.throws(() => setSlotCar(data, 0, donors[0]), RangeError);
});

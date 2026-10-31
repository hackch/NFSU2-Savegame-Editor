import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { nfsu2Crc } from '../model/checksum.js';
import { PERF_PARTS, PERF_CATEGORIES } from '../data/perf-parts.js';
import { UNLOCK_OFFSETS, UNLOCK_CATEGORY_OFFSETS } from '../data/unlock-table.js';
import {
  checkSave, verifyChecksums, recalculateChecksums, getMoney, setMoney, getName, setName, validateName,
} from '../model/save-file.js';
import { getPerfFlag, setPerfFlag, setPerfFlags, PERF_COUNT } from '../model/perf.js';
import {
  getCarKey, isSlotUsed, isSlotLinked, isSlotLocked, setSlotCar, swapSlots, unlockAllSlots,
} from '../model/slots.js';
import { countUnlocked, countUnlockedCategory, setUnlocks, setUnlockCategory, UNLOCK_COUNT } from '../model/unlocks.js';
import {
  SLOT_BASE, SLOT_STRIDE, PERF_OFF, MONEY_OFF, GARAGE_CAR_COUNT, SLOT_LINK_OFF, SLOT_LINK_LEN, SLOT_LOCK_REL,
} from '../model/layout.js';
import { parseCarDatabase, buildCarIndex, identifyCar, type Donor } from '../model/cars.js';

const FIXTURE = fileURLToPath(new URL('../../testfile/treav0r', import.meta.url));
const hasFixture = existsSync(FIXTURE);
const SKIP_NO_FIXTURE = !hasFixture && 'testfile/treav0r missing';
const load = (): Uint8Array => new Uint8Array(readFileSync(FIXTURE));

/** Byte offsets that differ between two buffers of equal length. */
function diffOffsets(a: Uint8Array, b: Uint8Array): number[] {
  const diffs: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diffs.push(i);
  return diffs;
}

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
  assert.deepEqual(diffOffsets(data, out), [SLOT_BASE + PERF_OFF + 15]);
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

test('unlock table has 420 distinct offsets inside one car slot', () => {
  assert.equal(UNLOCK_COUNT, 420);
  assert.equal(new Set(UNLOCK_OFFSETS).size, UNLOCK_COUNT);
  assert.ok(UNLOCK_OFFSETS.every((rel) => rel >= 0 && rel < SLOT_STRIDE));
});

test('setUnlocks on and off only changes unlock-table bytes of its own slot', () => {
  const data = new Uint8Array(SLOT_BASE + 5 * SLOT_STRIDE + 16).fill(0x11);
  const on = setUnlocks(data, 2, true);
  const base = SLOT_BASE + 2 * SLOT_STRIDE;
  const changed = diffOffsets(data, on);
  assert.deepEqual(changed, UNLOCK_OFFSETS.map((rel) => base + rel));
  assert.ok(changed.every((i) => on[i] === 0xff));
  assert.equal(countUnlocked(on, 2), UNLOCK_COUNT);
  assert.equal(countUnlocked(on, 1), 0);
  assert.equal(on.length, data.length);
  assert.equal(data[base + UNLOCK_OFFSETS[0]], 0x11, 'input is not mutated');

  const off = setUnlocks(on, 2, false);
  assert.equal(countUnlocked(off, 2), 0);
});

test('unlock categories partition the 420-byte table', () => {
  const names = Object.keys(UNLOCK_CATEGORY_OFFSETS);
  assert.deepEqual(names.sort(), ['bodyParts', 'graphics', 'performance', 'specialities']);
  const all = Object.values(UNLOCK_CATEGORY_OFFSETS).flat();
  assert.equal(new Set(all).size, UNLOCK_COUNT);
  assert.deepEqual([...all].sort((a, b) => a - b), UNLOCK_OFFSETS);
  assert.equal(UNLOCK_CATEGORY_OFFSETS.bodyParts.length, 220);
  assert.equal(UNLOCK_CATEGORY_OFFSETS.specialities.length, 80);
  assert.equal(UNLOCK_CATEGORY_OFFSETS.graphics.length, 112);
  assert.equal(UNLOCK_CATEGORY_OFFSETS.performance.length, 8);
});

test('setUnlockCategory only changes that category in its own slot', () => {
  const data = new Uint8Array(SLOT_BASE + 5 * SLOT_STRIDE + 16).fill(0x11);
  const base = SLOT_BASE + 1 * SLOT_STRIDE;
  const on = setUnlockCategory(data, 1, 'performance', true);
  assert.deepEqual(diffOffsets(data, on), UNLOCK_CATEGORY_OFFSETS.performance.map((rel) => base + rel));
  assert.equal(countUnlockedCategory(on, 1, 'performance'), 8);
  assert.equal(countUnlockedCategory(on, 1, 'graphics'), 0);
  assert.equal(countUnlocked(on, 1), 8);

  const off = setUnlockCategory(on, 1, 'performance', false);
  assert.equal(countUnlockedCategory(off, 1, 'performance'), 0);
});

test('fixture: checksums verify and recalculation is a no-op', { skip: SKIP_NO_FIXTURE }, () => {
  const data = load();
  assert.equal(checkSave(data).ok, true);
  assert.deepEqual(verifyChecksums(data), { blockA: true, blockB: true, header: true });
  assert.deepEqual(recalculateChecksums(data), data);
});

test('fixture: money and name edits recalculate to valid checksums', { skip: SKIP_NO_FIXTURE }, () => {
  const edited = recalculateChecksums(setName(setMoney(load(), 1337420), 'treav0r'));
  assert.equal(getMoney(edited), 1337420);
  assert.equal(getName(edited), 'treav0r');
  assert.equal(edited[MONEY_OFF], 1337420 & 0xff);
  assert.deepEqual(verifyChecksums(edited), { blockA: true, blockB: true, header: true });
});

test('fixture: slot usage reads without throwing', { skip: SKIP_NO_FIXTURE }, () => {
  const data = load();
  const used = [0, 1, 2, 3, 4].map((s) => isSlotUsed(data, s));
  assert.equal(used.length, 5);
});

const donorRaw: Record<string, { off: number; hex: string }[]> = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../car-donors.json', import.meta.url)), 'utf8'),
);
const donors = parseCarDatabase(donorRaw);
const carIndex = buildCarIndex(donors);

/**
 * Looks up a donor by display name.
 * @param name Exact donor name from car-donors.json.
 * @returns The matching donor. Throws when it is missing so tests fail loudly.
 */
function donorNamed(name: string): Donor {
  const donor = donors.find((d) => d.name === name);
  if (!donor) throw new Error(`Missing donor: ${name}`);
  return donor;
}

test('every donor has three slot blocks whose key matches its key block tail', () => {
  assert.equal(donors.length, 49);
  for (const donor of donors) {
    assert.deepEqual(donor.blocks.map((b) => b.off), [0x5870, 0x5950, 0x5b20]);
    const tail = donor.blocks[2].bytes.slice(-4);
    assert.equal(donor.key, Array.from(tail, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase());
  }
});

test('fixture: model keys identify the known cars and the empty slot is unknown', { skip: SKIP_NO_FIXTURE }, () => {
  const data = load();
  assert.equal(identifyCar(carIndex, getCarKey(data, 0))?.name, 'Mazda RX8');
  assert.equal(identifyCar(carIndex, getCarKey(data, 1))?.name, 'Nissan 240SX');
  assert.equal(identifyCar(carIndex, getCarKey(data, 2))?.name, 'Cadillac Escalade (SUV)');
  assert.equal(identifyCar(carIndex, getCarKey(data, 3))?.name, 'Toyota Trueno AE86 (Corolla)');
  assert.equal(getCarKey(data, 4), '00000000');
  assert.equal(identifyCar(carIndex, getCarKey(data, 4)), null);
});

test('fixture: replacing a used slot changes its car, resets parts to stock and recalculates cleanly', { skip: SKIP_NO_FIXTURE }, () => {
  const before = recalculateChecksums(setPerfFlag(setName(setMoney(load(), 1234), 'treav0r'), 0, 15, true));
  const target = donorNamed('Nissan 350Z');
  const after = recalculateChecksums(setSlotCar(before, 0, target));
  assert.equal(getCarKey(after, 0), target.key);
  assert.equal(identifyCar(carIndex, getCarKey(after, 0))?.name, 'Nissan 350Z');
  assert.equal(isSlotUsed(after, 0), true);
  assert.equal(getPerfFlag(after, 0, 15), false);
  for (let i = 0; i < PERF_COUNT; i++) assert.equal(getPerfFlag(after, 0, i), false);
  assert.equal(getMoney(after), 1234);
  assert.equal(getName(after), 'treav0r');
  assert.deepEqual(verifyChecksums(after), { blockA: true, blockB: true, header: true });
});

test('fixture: replacing a car only changes its slot and the checksum bytes', { skip: SKIP_NO_FIXTURE }, () => {
  const data = load();
  const out = setSlotCar(data, 1, donorNamed('Toyota Supra'));
  const diffs = diffOffsets(data, out);
  const slotStart = SLOT_BASE + SLOT_STRIDE;
  const slotEnd = SLOT_BASE + SLOT_STRIDE * 2;
  assert.ok(diffs.length > 0);
  for (const i of diffs) {
    const inSlot = i >= slotStart && i < slotEnd;
    const inHeaderCrc = i >= 0x10 && i < 0x1c;
    assert.ok(inSlot || inHeaderCrc, `unexpected change at 0x${i.toString(16)}`);
  }
});

test('fixture: empty slot 5 becomes a used and linked car, and the garage count admits it', { skip: SKIP_NO_FIXTURE }, () => {
  const data = load();
  assert.equal(data[GARAGE_CAR_COUNT], 4);
  assert.equal(isSlotLinked(data, 4), false);
  const out = setSlotCar(data, 4, donorNamed('Mazda Miata MX5'));
  assert.equal(isSlotUsed(out, 4), true);
  assert.equal(isSlotLinked(out, 4), true);
  assert.equal(identifyCar(carIndex, getCarKey(out, 4))?.name, 'Mazda Miata MX5');
  assert.equal(out[GARAGE_CAR_COUNT], 5);
  const headerStart = SLOT_BASE + 4 * SLOT_STRIDE + 0x27c;
  assert.deepEqual(out.slice(headerStart, headerStart + 24), data.slice(SLOT_BASE + 0x27c, SLOT_BASE + 0x27c + 24));
  const linkStart = SLOT_BASE + 4 * SLOT_STRIDE + SLOT_LINK_OFF;
  assert.deepEqual(out.slice(linkStart, linkStart + SLOT_LINK_LEN), data.slice(SLOT_BASE + SLOT_LINK_OFF, SLOT_BASE + SLOT_LINK_OFF + SLOT_LINK_LEN));
});

test('setSlotCar never lowers the garage count', { skip: SKIP_NO_FIXTURE }, () => {
  const data = load();
  const out = setSlotCar(data, 0, donorNamed('Toyota Supra'));
  assert.equal(out[GARAGE_CAR_COUNT], data[GARAGE_CAR_COUNT]);
});

test('fixture: unlockAllSlots raises the count to 6, clears every lock flag and links every slot without adding cars', { skip: SKIP_NO_FIXTURE }, () => {
  const data = load();
  const out = unlockAllSlots(data);
  assert.equal(out[GARAGE_CAR_COUNT], 6);
  for (let i = 0; i < 5; i++) {
    assert.equal(isSlotLocked(out, i), false);
    assert.equal(isSlotLinked(out, i), true);
  }
  assert.equal(isSlotUsed(out, 4), false);
  assert.equal(getCarKey(out, 4), '00000000');
});

test('setSlotCar refuses when there is no used slot to copy the header from', () => {
  const data = new Uint8Array(0xd300);
  assert.throws(() => setSlotCar(data, 0, donors[0]), RangeError);
});

test('lock state follows each slot\'s own flag, not the garage count', () => {
  const data = new Uint8Array(0xd300);
  data[GARAGE_CAR_COUNT] = 1;
  for (let s = 0; s < 5; s++) data[SLOT_BASE + s * SLOT_STRIDE + SLOT_LOCK_REL] = 1;
  assert.deepEqual([0, 1, 2, 3, 4].map((s) => isSlotLocked(data, s)), [true, true, true, true, true]);
  data[SLOT_BASE + 2 * SLOT_STRIDE + SLOT_LOCK_REL] = 0;
  assert.deepEqual([0, 1, 2, 3, 4].map((s) => isSlotLocked(data, s)), [true, true, false, true, true]);
});

test('lock flag of a slot is read from its own record', () => {
  const data = new Uint8Array(0xd300);
  data[SLOT_BASE + 3 * SLOT_STRIDE + SLOT_LOCK_REL] = 1;
  assert.deepEqual([0, 1, 2, 3, 4].map((s) => isSlotLocked(data, s)), [false, false, false, true, false]);
});

test('fixture: setSlotCar clears only the lock flag of the slot it writes', { skip: SKIP_NO_FIXTURE }, () => {
  const data = load();
  assert.deepEqual([0, 1, 2, 3, 4].map((s) => isSlotLocked(data, s)), [false, false, false, false, true]);
  const out = setSlotCar(data, 4, donorNamed('Toyota Supra'));
  assert.deepEqual([0, 1, 2, 3, 4].map((s) => isSlotLocked(out, s)), [false, false, false, false, false]);
});

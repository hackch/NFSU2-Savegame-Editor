import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { nfsu2Crc } from '../model/checksum.js';
import {
  PERF_PARTS, PERF_CATEGORIES, TUNING_PERF_CATEGORIES, TUNING_PERF_INDICES, UNIQUE_PERF_PARTS,
} from '../data/perf-parts.js';
import { EditorController } from '../controller/editor-controller.js';
import type { EditorScope } from '../controller/editor-scope.js';
import { UNLOCK_OFFSETS, UNLOCK_CATEGORY_OFFSETS } from '../data/unlock-table.js';
import {
  checkSave, verifyChecksums, recalculateChecksums, getMoney, setMoney, getName, setName, validateName,
} from '../model/save-file.js';
import {
  getPerfFlag, getPerfPurchased, getUniquePerfValue, perfOffset, perfPurchaseOffset,
  setPerfFlag, setPerfFlags, setUniquePerfFlag, uniquePerfOffset, PERF_COUNT, UNIQUE_PERF_COUNT,
} from '../model/perf.js';
import {
  getCarKey, getCarTypeHash, isCarBought, isSlotUsed, isSlotLinked, isSlotLocked, setSlotCar, setSlotLocked, slotState, swapSlots,
} from '../model/slots.js';
import { countUnlocked, countUnlockedCategory, setUnlocks, setUnlockCategory, UNLOCK_COUNT } from '../model/unlocks.js';
import {
  MAGIC, HEADER_SIZE, SLOT_BASE, SLOT_COUNT, SLOT_STRIDE, SLOT_USED_OFF, PERF_OFF, MONEY_OFF, GARAGE_CAR_COUNT,
  SLOT_LINK_OFF, SLOT_LINK_LEN, SLOT_LOCK_REL, SLOT_BOUGHT_REL, UNIQUE_PERF_OFF,
} from '../model/layout.js';
import { parseCarDatabase, buildCarIndex, identifyCar, type Donor } from '../model/cars.js';
import {
  DynoModel, ECU_OFF, MAX_TUNE_BYTE, SETUP_SIZE, TUNING_OFF, findCar, optimizeSetup, parseGameData, readSlotDyno,
  setSetupCurves, setSetupTuning, setupOffset,
  type DynoGoal, type DynoResult,
} from '../model/dyno.js';

const FIXTURE = fileURLToPath(new URL('../../testfile/treav0r', import.meta.url));
const hasFixture = existsSync(FIXTURE);
const SKIP_NO_FIXTURE = !hasFixture && 'testfile/treav0r missing';
const load = (): Uint8Array => new Uint8Array(readFileSync(FIXTURE));

test('built page includes its version, numeric UTC build stamp and splash label', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.ok(html.includes(`v${version} &middot; Build `));
  assert.match(html, /Build \d{14}<\/span>/);
  assert.ok(html.includes('Now with DYNO!'));
  assert.ok(!html.includes('__APP_VERSION__'));
  assert.ok(!html.includes('__BUILD_NUMBER__'));
});

test('tuning page keeps names and controls without technical metadata', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(html.includes('{{ part.label }}'));
  assert.ok(html.includes('{{ part.packageLabel }}'));
  assert.ok(html.includes('ng-change="togglePart(part)"'));
  assert.ok(html.includes('ng-change="toggleUnique(cat.unique)"'));
  for (const metadata of ['tuning-part-meta', 'PERF_PART_', 'Archive price:', 'Purchase bit:',
    'part.offset', 'part.index }}', 'cat.unique.offset', 'cat.unique.hexValue', 'uint32 LE:']) {
    assert.ok(!html.includes(metadata), `Page should not display ${metadata}`);
  }
});

test('dyno goal selector exposes all supported goals', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const goals: [DynoGoal, string][] = [
    ['quarter', 'Quickest quarter mile'], ['accel60', 'Quickest 0–60 mph'],
    ['accel', 'Quickest 0–100 mph'], ['top', 'Highest top speed'],
    ['power', 'Maximum horsepower'], ['torque', 'Maximum torque'],
  ];
  for (const [value, label] of goals) assert.ok(html.includes(`<option value="${value}">${label}</option>`));
  assert.ok(html.includes('ng-model="tuning.dyno.optimizeGearing" ng-change="setGoal()"'));
});

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

test('performance tuning includes nine categories and 54 active IDs, not visual-related IDs', () => {
  assert.deepEqual(TUNING_PERF_CATEGORIES.map((category) => category.code),
    ['WT', 'TR', 'NO', 'EN', 'TU', 'SU', 'BR', 'EC', 'TI']);
  assert.deepEqual(TUNING_PERF_INDICES, Array.from({ length: 56 }, (_, index) => index)
    .filter((index) => index !== 33 && index !== 34));
  assert.equal(TUNING_PERF_INDICES.length, 54);
  assert.deepEqual(PERF_CATEGORIES.find((category) => category.code === 'AE')?.indices,
    Array.from({ length: 12 }, (_, index) => index + 56));
});

test('active archive records retain IDs and describe ordinary packages, not uniques', () => {
  const active = PERF_PARTS.filter((part) => part.active);
  assert.equal(active.length, 66);
  assert.equal(active.filter((part) => part.category !== 'AE').length, 54);
  assert.deepEqual(PERF_PARTS.filter((part) => !part.active).map((part) => part.index), [33, 34]);
  assert.equal(PERF_PARTS[12].key, 'NO_DRY_SHOT_OF_NITROUS');
  assert.equal(PERF_PARTS[14].key, 'NO_DIRECT_PORT_NITROUS_OXIDE');
  assert.equal(PERF_PARTS[35].key, 'SU_COIL_OVER_SUSPENSION_SYSTEM');
  assert.equal(PERF_PARTS[36].level, 2, 'camber kit remains a Pro part at ID 36');
  assert.equal(PERF_PARTS[35].level, 3);
  assert.equal(PERF_PARTS[14].price, 4000);
  assert.deepEqual(PERF_PARTS[15].conflicts, [19]);
  assert.deepEqual(PERF_PARTS[33].conflicts, []);
  assert.equal(PERF_PARTS[33].level, null);
  assert.equal(PERF_PARTS[33].price, null);
  for (const part of active) {
    assert.ok(part.level !== null && part.level >= 1 && part.level <= 3);
    assert.ok(part.price !== null && part.price >= 0);
    for (const id of part.conflicts) {
      assert.ok(PERF_PARTS[id].active);
      assert.equal(PERF_PARTS[id].category, part.category);
      assert.notEqual(id, part.index);
    }
  }
});

test('unique category names match the game category index order, without an aero guess', () => {
  assert.equal(UNIQUE_PERF_COUNT, 9);
  assert.deepEqual(UNIQUE_PERF_PARTS.map((part) => part.category), ['WT', 'TR', 'NO', 'EN', 'TU', 'SU', 'BR', 'EC', 'TI']);
  assert.deepEqual(UNIQUE_PERF_PARTS.map((part) => part.key), [
    'PERF_CATEGORY_WEIGHT_REDUCTION', 'PERF_CATEGORY_TRANSMISSION', 'PERF_CATEGORY_NOS',
    'PERF_CATEGORY_ENGINE', 'PERF_CATEGORY_TURBO', 'PERF_CATEGORY_SUSPENSION',
    'PERF_CATEGORY_BRAKE', 'PERF_CATEGORY_ECU', 'PERF_CATEGORY_TIRES',
  ]);
});

test('all 45 unique offsets and writes touch only their four-byte field', () => {
  const firstOffsets = [0x5b58, 0x634a, 0x6b3c, 0x732e, 0x7b20];
  const data = new Uint8Array(0xd6b6).fill(0xa5);
  for (let slot = 0; slot < 5; slot++) {
    for (let category = 0; category < 9; category++) {
      const offset = firstOffsets[slot] + category * 4;
      assert.equal(uniquePerfOffset(slot, category), offset);
      assert.equal(getUniquePerfValue(data, slot, category), 0xa5a5a5a5);
      const out = setUniquePerfFlag(data, slot, category, true);
      assert.deepEqual(diffOffsets(data, out), [offset, offset + 1, offset + 2, offset + 3]);
      assert.deepEqual([...out.slice(offset, offset + 4)], [1, 0, 0, 0]);
      assert.equal(getUniquePerfValue(out, slot, category), 1);
      const off = setUniquePerfFlag(out, slot, category, false);
      assert.equal(getUniquePerfValue(off, slot, category), 0);
      assert.deepEqual([...off.slice(offset, offset + 4)], [0, 0, 0, 0]);
      assert.equal(getUniquePerfValue(data, slot, category), 0xa5a5a5a5, 'input is immutable');
    }
    const unknown = SLOT_BASE + slot * SLOT_STRIDE + UNIQUE_PERF_OFF + 9 * 4;
    assert.equal(data[unknown], 0xa5);
  }
});

test('unique dwords and purchase bits respect a Uint8Array byteOffset', () => {
  const backing = new Uint8Array(0xd6b6 + 20).fill(0xaa);
  const data = backing.subarray(10, -10);
  const offset = uniquePerfOffset(2, 4);
  new DataView(data.buffer, data.byteOffset, data.byteLength).setUint32(offset, 0x12345678, true);
  assert.equal(getUniquePerfValue(data, 2, 4), 0x12345678);
  const out = setUniquePerfFlag(data, 2, 4, false);
  assert.equal(getUniquePerfValue(out, 2, 4), 0);
  assert.equal(getUniquePerfValue(data, 2, 4), 0x12345678);
  data[perfPurchaseOffset(2, 67)] = 8;
  assert.equal(getPerfPurchased(data, 2, 67), true);
  assert.equal(getPerfPurchased(data, 2, 66), false);
  assert.equal(backing[0], 0xaa);
});

test('ownership bits are independent of installed bytes and cover IDs beyond 63', () => {
  const data = new Uint8Array(0xd6b6);
  const ids = [0, 7, 8, 63, 64, 67];
  for (const id of ids) data[perfPurchaseOffset(4, id)] |= 1 << (id & 7);
  for (let id = 0; id < PERF_COUNT; id++) {
    assert.equal(getPerfPurchased(data, 4, id), ids.includes(id));
    assert.equal(getPerfFlag(data, 4, id), false);
    assert.equal(perfOffset(4, id), SLOT_BASE + 4 * SLOT_STRIDE + 0x310 + id);
  }
  assert.equal(perfPurchaseOffset(4, 67), SLOT_BASE + 4 * SLOT_STRIDE + 0x58e);
  assert.equal(getPerfFlag(setPerfFlag(data, 4, 15, true), 4, 15), true);
  assert.equal(getPerfPurchased(data, 4, 15), false);
});

test('performance bulk edits preserve visual, unique, purchase, inactive and event-state fields', () => {
  const data = new Uint8Array(0xd6b6).fill(0xa5);
  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    const expected = TUNING_PERF_INDICES.map((id) => perfOffset(slot, id));
    const out = setPerfFlags(data, slot, TUNING_PERF_INDICES, true);
    assert.deepEqual(diffOffsets(data, out), expected);
    const cleared = setPerfFlags(out, slot, TUNING_PERF_INDICES, false);
    assert.deepEqual(diffOffsets(out, cleared), expected);
    assert.equal(getUniquePerfValue(out, slot, 8), 0xa5a5a5a5);
    assert.equal(out[perfOffset(slot, 33)], 0xa5);
    assert.equal(out[perfOffset(slot, 34)], 0xa5);
    for (let id = 56; id <= 67; id++) {
      assert.equal(out[perfOffset(slot, id)], 0xa5);
      assert.equal(cleared[perfOffset(slot, id)], 0xa5);
    }
  }
});

test('controller tuning and bulk controls exclude visual-related flags in every slot', async (t) => {
  const source = new Uint8Array(0xd6b6);
  const view = new DataView(source.buffer);
  source.set(MAGIC);
  view.setUint16(4, source.length & 0xffff, true);
  view.setUint32(8, source.length - HEADER_SIZE, true);
  view.setUint32(12, 0, true);
  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    view.setUint16(SLOT_BASE + slot * SLOT_STRIDE + SLOT_USED_OFF, 1, true);
    source[SLOT_BASE + slot * SLOT_STRIDE + SLOT_BOUGHT_REL] = 1;
    for (let index = 0; index < UNIQUE_PERF_COUNT; index++) {
      view.setUint32(uniquePerfOffset(slot, index), 0x10203040 + slot * 16 + index, true);
    }
    for (let index = 0; index <= 64; index += 8) {
      source[perfPurchaseOffset(slot, index)] = 0x30 + slot + index / 8;
    }
    source[perfOffset(slot, 33)] = 0xc1;
    source[perfOffset(slot, 34)] = 0xc2;
    for (let index = 56; index <= 67; index++) {
      source[perfOffset(slot, index)] = 0x80 + slot * 12 + index - 56;
    }
  }

  function replaceProperty(target: object, key: PropertyKey, value: unknown): void {
    const original = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(target, key, original);
      else Reflect.deleteProperty(target, key);
    });
  }

  class TestFileReader {
    result = source.buffer.slice(0);
    onload: (() => void) | null = null;
    readAsArrayBuffer(): void {
      assert.ok(this.onload);
      this.onload();
    }
  }

  const downloads: Blob[] = [];
  const confirmations: string[] = [];
  replaceProperty(globalThis, 'FileReader', TestFileReader);
  replaceProperty(globalThis, 'fetch', () => Promise.resolve({ ok: true, json: async () => ({}) }));
  replaceProperty(globalThis, 'confirm', (message: string) => {
    confirmations.push(message);
    return true;
  });
  replaceProperty(globalThis, 'document', {
    createElement: () => ({ click() {}, remove() {} }),
    body: { appendChild() {} },
  });
  replaceProperty(URL, 'createObjectURL', (blob: Blob) => {
    downloads.push(blob);
    return 'blob:controller-test';
  });

  const scope = {
    $apply(callback: () => void) { callback(); },
    $evalAsync(callback: () => void) { callback(); },
  } as EditorScope;
  EditorController(scope);
  scope.loadFile({ name: 'synthetic-save' } as File);
  assert.equal(scope.loaded, true);
  assert.equal(scope.perfTotal, 54);
  assert.deepEqual(scope.slots.map((slot) => slot.perfCount), [0, 0, 0, 0, 0]);

  async function snapshot(): Promise<Uint8Array> {
    scope.download();
    const blob = downloads.pop();
    assert.ok(blob);
    return new Uint8Array(await blob.arrayBuffer());
  }

  function payloadDiff(before: Uint8Array, after: Uint8Array): number[] {
    return diffOffsets(before, after).filter((offset) => offset >= HEADER_SIZE);
  }

  const baseline = await snapshot();
  scope.openTuning(0);
  const firstCategory = scope.tuning.categories[0];
  const hiddenPart = { ...firstCategory.parts[0], index: 56, on: false };
  scope.togglePart(hiddenPart);
  assert.equal(scope.status.type, 'error');
  assert.deepEqual(payloadDiff(baseline, await snapshot()), []);

  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    scope.openTuning(slot);
    assert.deepEqual(scope.tuning.categories.map((category) => category.code),
      ['WT', 'TR', 'NO', 'EN', 'TU', 'SU', 'BR', 'EC', 'TI']);
    assert.equal(scope.tuning.categories.flatMap((category) => category.parts).length, 56);
    assert.equal(scope.tuning.categories.filter((category) => category.unique !== null).length, 9);
    const before = await snapshot();
    const perfBytes = TUNING_PERF_INDICES.map((index) => perfOffset(slot, index));
    const uniqueBytes = UNIQUE_PERF_PARTS.flatMap((part) => {
      const start = uniquePerfOffset(slot, part.index);
      return [start, start + 1, start + 2, start + 3];
    });
    scope.maxOut(slot);
    assert.equal(scope.slots[slot].perfCount, 54);
    assert.equal(scope.slots[slot].uniqueCount, UNIQUE_PERF_PARTS.length);
    const after = await snapshot();
    const allowed = new Set([...perfBytes, ...uniqueBytes]);
    assert.deepEqual(payloadDiff(before, after).filter((offset) => !allowed.has(offset)), []);
    for (const offset of perfBytes) assert.equal(after[offset], 1);
    for (const part of UNIQUE_PERF_PARTS) {
      assert.equal(new DataView(after.buffer).getUint32(uniquePerfOffset(slot, part.index), true), 1);
    }
  }
  assert.deepEqual(confirmations, []);
});


test('invalid tuning addresses and truncated unique/ownership reads throw', () => {
  const data = new Uint8Array(0xd6b6);
  for (const index of [-1, 9, 0.5, NaN, Infinity]) {
    assert.throws(() => uniquePerfOffset(0, index), RangeError);
    assert.throws(() => setUniquePerfFlag(data, 0, index, true), RangeError);
  }
  for (const slot of [-1, 5, 0.5, NaN]) {
    assert.throws(() => uniquePerfOffset(slot, 0), RangeError);
    assert.throws(() => perfPurchaseOffset(slot, 0), RangeError);
  }
  for (const index of [-1, 68, 0.5, NaN]) {
    assert.throws(() => perfPurchaseOffset(0, index), RangeError);
  }
  const short = new Uint8Array(uniquePerfOffset(0, 0) + 3);
  assert.throws(() => getUniquePerfValue(short, 0, 0), RangeError);
  assert.throws(() => setUniquePerfFlag(short, 0, 0, true), RangeError);
  assert.throws(() => getPerfPurchased(new Uint8Array(1), 0, 0), RangeError);
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
    const block = donor.blocks[0].bytes;
    assert.equal(donor.hash, new DataView(block.buffer, block.byteOffset, block.byteLength).getUint32(0x14, true));
  }
});

test('every donor replacement identifies its car type in every slot, including shared-key cars', () => {
  const source = new Uint8Array(0xd300);
  source[SLOT_BASE + SLOT_USED_OFF] = 1;
  for (const donor of donors) {
    const canonical = donors.find((d) => d.hash === donor.hash);
    assert.ok(canonical);
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      const out = setSlotCar(source, slot, donor);
      assert.equal(getCarTypeHash(out, slot), donor.hash);
      assert.equal(identifyCar(carIndex, getCarTypeHash(out, slot))?.name, canonical.name);
      assert.equal(readSlotDyno(out, slot).hash, donor.hash);
      assert.equal(slotState(out, slot), 'filled');
    }
  }
  const collision = ['Nissan Sentra SE-R Spec V', 'Volkswagen Golf', 'Hyundai Tiburon GT'].map(donorNamed);
  assert.equal(new Set(collision.map((d) => d.key)).size, 1);
  assert.equal(new Set(collision.map((d) => d.hash)).size, 3);
  for (const donor of collision) assert.equal(identifyCar(carIndex, donor.hash)?.name, donor.name);
  assert.equal(identifyCar(carIndex, donorNamed("Audi TT 'Scott'").hash)?.name, 'Audi TT');
  assert.equal(identifyCar(carIndex, donorNamed("Ford Mustang GT 'Nikki'").hash)?.name, 'Ford Mustang GT');
  assert.equal(identifyCar(carIndex, 0), null);
  assert.equal(identifyCar(carIndex, 0xffffffff), null);
  const padded = new Uint8Array(source.length + 11);
  padded.set(setSlotCar(source, 2, donorNamed('Hyundai Tiburon GT')), 11);
  assert.equal(getCarTypeHash(padded.subarray(11), 2), donorNamed('Hyundai Tiburon GT').hash);
  assert.throws(() => getCarTypeHash(source, 5), RangeError);
});

test('controller replacement shows Tiburon, Golf and Sentra as distinct cars', { skip: SKIP_NO_FIXTURE }, async (t) => {
  function replace(target: object, key: PropertyKey, value: unknown): void {
    const original = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(target, key, original);
      else Reflect.deleteProperty(target, key);
    });
  }
  class TestFileReader {
    result = load().buffer;
    onload: (() => void) | null = null;
    readAsArrayBuffer(): void { this.onload?.(); }
  }
  replace(globalThis, 'FileReader', TestFileReader);
  replace(globalThis, 'fetch', () => Promise.resolve({ ok: true, json: async () => donorRaw }));
  replace(globalThis, 'confirm', () => true);
  const scope = {
    $apply(callback: () => void) { callback(); },
    $evalAsync(callback: () => void) { callback(); },
  } as EditorScope;
  EditorController(scope);
  scope.loadFile({ name: 'career' } as File);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(scope.donors.length, donors.length);
  for (const name of ['Hyundai Tiburon GT', 'Volkswagen Golf', 'Nissan Sentra SE-R Spec V', 'Audi TT']) {
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      if (scope.slots[slot].locked) scope.toggleLock(slot);
      scope.replaceTarget[slot] = donorNamed(name).id;
      scope.replaceCar(slot);
      assert.equal(scope.slots[slot].car?.name, name);
      assert.equal(scope.slots[slot].state, 'filled');
      assert.equal(scope.status.type, 'success');
    }
  }
});

test('fixture: car type hashes identify the known cars and the empty slot is unknown', { skip: SKIP_NO_FIXTURE }, () => {
  const data = load();
  assert.equal(identifyCar(carIndex, getCarTypeHash(data, 0))?.name, 'Mazda RX8');
  assert.equal(identifyCar(carIndex, getCarTypeHash(data, 1))?.name, 'Nissan 240SX');
  assert.equal(identifyCar(carIndex, getCarTypeHash(data, 2))?.name, 'Cadillac Escalade (SUV)');
  assert.equal(identifyCar(carIndex, getCarTypeHash(data, 3))?.name, 'Toyota Trueno AE86 (Corolla)');
  assert.equal(getCarKey(data, 4), '00000000');
  assert.equal(identifyCar(carIndex, getCarTypeHash(data, 4)), null);
});

test('fixture: replacing a used slot changes its car, resets parts to stock and recalculates cleanly', { skip: SKIP_NO_FIXTURE }, () => {
  const before = recalculateChecksums(setPerfFlag(setName(setMoney(load(), 1234), 'treav0r'), 0, 15, true));
  const target = donorNamed('Nissan 350Z');
  const after = recalculateChecksums(setSlotCar(before, 0, target));
  assert.equal(getCarKey(after, 0), target.key);
  assert.equal(identifyCar(carIndex, getCarTypeHash(after, 0))?.name, 'Nissan 350Z');
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
  assert.equal(identifyCar(carIndex, getCarTypeHash(out, 4))?.name, 'Mazda Miata MX5');
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

test('fixture: setSlotCar on a locked slot unlocks it, sets the bought flag and shows it as filled', { skip: SKIP_NO_FIXTURE }, () => {
  const data = load();
  assert.equal(slotState(data, 4), 'locked');
  const out = setSlotCar(data, 4, donorNamed('Toyota Supra'));
  assert.equal(isSlotLocked(out, 4), false);
  assert.equal(isCarBought(out, 4), true);
  assert.equal(out[SLOT_BASE + 4 * SLOT_STRIDE + SLOT_BOUGHT_REL], 1);
  assert.equal(slotState(out, 4), 'filled');
});

test('fixture: an unlocked slot with no bought car is open, not filled', { skip: SKIP_NO_FIXTURE }, () => {
  const data = load();
  const out = setSlotCar(data, 0, donorNamed('Toyota Supra'));
  const cleared = new Uint8Array(out);
  cleared[SLOT_BASE + 1 * SLOT_STRIDE + SLOT_LOCK_REL] = 0;
  cleared[SLOT_BASE + 1 * SLOT_STRIDE + SLOT_BOUGHT_REL] = 0;
  assert.equal(slotState(cleared, 1), 'open');
  assert.equal(slotState(cleared, 0), 'filled');
});

test('setSlotLocked changes only the lock flag of its own slot', () => {
  const data = new Uint8Array(0xd300);
  const out = setSlotLocked(data, 3, true);
  assert.equal(isSlotLocked(out, 3), true);
  assert.deepEqual(diffOffsets(data, out), [SLOT_BASE + 3 * SLOT_STRIDE + SLOT_LOCK_REL]);
  assert.equal(isSlotLocked(setSlotLocked(out, 3, false), 3), false);
});

test('slotState gives locked priority over bought', () => {
  const data = new Uint8Array(0xd300);
  const base = SLOT_BASE + 2 * SLOT_STRIDE;
  data[base + SLOT_LOCK_REL] = 1;
  data[base + SLOT_BOUGHT_REL] = 1;
  assert.equal(slotState(data, 2), 'locked');
  data[base + SLOT_LOCK_REL] = 0;
  assert.equal(slotState(data, 2), 'filled');
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

const GAME_BUN = process.env.NFSU2_GLOBALB ?? 'C:/Program Files (x86)/EA GAMES/Need for Speed Underground 2/GLOBAL/GLOBALB.BUN';
const SKIP_NO_GAME = (!existsSync(GAME_BUN) || !hasFixture) && 'GLOBALB.BUN (set NFSU2_GLOBALB) or testfile/treav0r missing';

test('setSetupCurves writes only the ECU and turbo bytes of one setup', () => {
  const data = new Uint8Array(0xd300);
  const setup = new Uint8Array(SETUP_SIZE).fill(7);
  const out = setSetupCurves(data, 2, 1, setup);
  const start = setupOffset(2, 1);
  assert.equal(start, SLOT_BASE + 2 * SLOT_STRIDE + TUNING_OFF + SETUP_SIZE);
  assert.deepEqual(diffOffsets(data, out), Array.from({ length: SETUP_SIZE - ECU_OFF }, (_, i) => start + ECU_OFF + i));
  assert.equal(data[start + ECU_OFF], 0);
  assert.throws(() => setupOffset(0, 5), RangeError);
  assert.throws(() => setSetupCurves(data, 0, 0, new Uint8Array(40)), RangeError);
});

test('setSetupTuning optionally writes gearing without touching other setup or save bytes', () => {
  const data = new Uint8Array(0xd300).fill(13);
  const setup = new Uint8Array(SETUP_SIZE).fill(100);
  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    for (let index = 0; index < 5; index++) {
      const start = setupOffset(slot, index);
      const out = setSetupTuning(data, slot, index, setup, true);
      assert.deepEqual(diffOffsets(data, out), [
        ...Array.from({ length: 7 }, (_, i) => start + 9 + i),
        ...Array.from({ length: 18 }, (_, i) => start + ECU_OFF + i),
      ]);
      assert.deepEqual(setSetupTuning(data, slot, index, setup), setSetupCurves(data, slot, index, setup));
      assert.equal(data[start + 9], 13);
    }
  }
  assert.throws(() => setSetupTuning(data, 0, 0, new Uint8Array(40), true), RangeError);
});

test('parseGameData rejects files without the car tables', () => {
  assert.throws(() => parseGameData(new Uint8Array(64)), /GLOBALB\.BUN/);
});

test('new dyno goals optimize their selected metric independently', () => {
  const car = { index: 0, name: 'Goal test', hash: 1, view: new DataView(new ArrayBuffer(0x780)) };
  const game = { cars: [car], packages: [],
    tuning: [{ item: 48, level: 1, param: 23, type: 1, f8: -0.06, fC: 0.03 }] };
  const installed = new Array<boolean>(68).fill(false);
  installed[48] = true;
  class GoalModel extends DynoModel {
    override evaluate(setup: ArrayLike<number>): DynoResult {
      const b = setup[ECU_OFF];
      return {
        t60: 1 + Math.abs(b - 35), t100: Infinity, quarterMile: Infinity, quarterExact: Infinity,
        topSpeed: 100, trapSpeed: 0, peakPower: 1000 - Math.abs(b - 145), peakPowerRpm: 6000,
        peakTorque: 2000 - Math.abs(b - 185), peakTorqueRpm: 4000,
      };
    }
  }
  const model = new GoalModel(game, car, installed, new Array<number>(9).fill(0));
  const current = new Uint8Array(SETUP_SIZE).fill(100);
  const original = current.slice();
  const goals: [DynoGoal, number][] = [['accel60', 35], ['power', 145], ['torque', 185]];
  for (const [goal, bestByte] of goals) {
    const result = optimizeSetup(model, current, goal);
    assert.equal(result.setup[ECU_OFF], bestByte);
    assert.deepEqual(result.after, model.evaluate(result.setup));
    assert.deepEqual(result.before, model.evaluate(current));
    assert.deepEqual(diffOffsets(current, result.setup), [ECU_OFF]);
    assert.deepEqual(current, original);
  }
});

test('gearing load matches native byte normalization and adjacent-gear propagation', () => {
  // SPEED2.EXE's load/setter/writer executed with synthetic range and unique hooks.
  const cases = [
    { bytes: [100, 100, 100, 100, 100, 100, 100], fd: 4,
      ratios: [3.5, 2.1, 1.5, 1.1, 0.85], sixth: 0.7 },
    { bytes: [0, 0, 0, 0, 0, 0, 0], fd: 3.8,
      ratios: [2.7, 1.5, 1.1, 0.8, 0.75], sixth: 0.7 },
    { bytes: [200, 200, 200, 200, 200, 200, 200], fd: 4.4,
      ratios: [4.5, 2.898, 2.1, 1.499, 1.0985], sixth: 0.8 },
    { bytes: [100, 0, 200, 0, 200, 0, 200], fd: 4,
      ratios: [2.7, 2.646, 1.55, 1.499, 0.75], sixth: 0.8,
      sixRatios: [2.7, 2.646, 1.55, 1.499, 0.85, 0.8] },
  ];
  for (const count of [5, 6]) {
    const view = new DataView(new ArrayBuffer(0x780));
    view.setInt32(0x1c8, count, true);
    const base = [3.5, 2.1, 1.5, 1.1, 0.85, count === 6 ? 0.7 : 0];
    for (const [off, value] of [
      [0x1b8, 4], [0x1bc, 4], [0x3d8, 4], [0x1f4, 6000], [0x50, 0.3], [0x80, 0.3],
      ...base.map((value, i) => [0x1d8 + i * 4, value]),
    ]) view.setFloat32(off, value, true);
    const car = { index: 0, name: 'Synthetic gearbox', hash: 1, view };
    const tuning = [[-0.2, 0.4], [-0.8, 1], [-0.6, 0.8], [-0.4, 0.6],
      [-0.3, 0.4], [-0.1, 0.25], [0, 0.1]].map(([f8, fC], i) =>
      ({ item: 11, level: 3, param: 9 + i, type: 1, f8, fC }));
    const installed = new Array<boolean>(68).fill(false);
    installed[11] = true;
    const game = { cars: [car], packages: [], tuning };
    const model = new DynoModel(game, car, installed, new Array<number>(9).fill(0));
    for (const c of cases) {
      const setup = new Uint8Array(SETUP_SIZE).fill(100);
      setup.set(c.bytes, 9);
      const original = setup.slice();
      const phys = model.tuned(setup);
      const expected = count === 6 ? c.sixRatios ?? [...c.ratios, c.sixth] : [...c.ratios, 0];
      expected.forEach((ratio, i) =>
        assert.ok(Math.abs(phys.f[(0x1d8 >> 2) + i] - ratio) < 1e-6, `${count} gears, ${c.bytes}: gear ${i + 1}`));
      assert.ok(Math.abs(phys.f[0x1b8 >> 2] - c.fd) < 1e-6);
      assert.equal(phys.f[0x1b8 >> 2], phys.f[0x1bc >> 2]);
      assert.deepEqual(setup, original);
      assert.deepEqual(model.tuned(setup), phys);
    }
    installed[11] = false;
    const stock = new DynoModel(game, car, installed, new Array<number>(9).fill(0));
    assert.deepEqual(stock.tuned(new Uint8Array(SETUP_SIZE).fill(200)), stock.base);
  }
});

test('game data: dyno matches the traced reference model on the fixture', { skip: SKIP_NO_GAME }, () => {
  const game = parseGameData(new Uint8Array(readFileSync(GAME_BUN)));
  const data = load();
  const golden = [
    { name: 'RX8', t60: 3.3812, t100: 8.021333, qm: 10.666667, trap: 131.85041, top: 213.000015, kw: 354.539061, nm: 366.000034 },
    { name: '240SX', t60: 3.872, t100: 8.211667, qm: 10.75, trap: 134.959706, top: 219.000015, kw: 374.591718, nm: 453.958934 },
    { name: 'ESCALADE', t60: 3.996, t100: 11.523, qm: 11.9, trap: 122.587259, top: 210.000015, kw: 416.872766, nm: 686.628708 },
    { name: 'COROLLA', t60: 2.9568, t100: 7.564, qm: 10.583333, trap: 136.757271, top: 213.000015, kw: 318.757503, nm: 365.708328 },
  ];
  golden.forEach((want, slot) => {
    const sd = readSlotDyno(data, slot);
    const car = findCar(game, sd.hash);
    assert.equal(car?.name, want.name);
    const r = new DynoModel(game, car!, sd.installed, sd.uniques).evaluate(sd.setups[1]);
    for (const [got, exp] of [[r.t60, want.t60], [r.t100, want.t100], [r.quarterMile, want.qm], [r.trapSpeed, want.trap],
      [r.topSpeed, want.top], [r.peakPower, want.kw], [r.peakTorque, want.nm]]) {
      assert.ok(Math.abs(got - exp) < 1e-4, `${want.name}: ${got} vs ${exp}`);
    }
  });
});

test('game data: auto-tune improves the quarter mile and only changes curve bytes', { skip: SKIP_NO_GAME }, () => {
  const game = parseGameData(new Uint8Array(readFileSync(GAME_BUN)));
  const sd = readSlotDyno(load(), 0);
  const model = new DynoModel(game, findCar(game, sd.hash)!, sd.installed, sd.uniques);
  assert.ok(model.ecuTunable && model.turboTunable);
  const { setup, before, after } = optimizeSetup(model, sd.setups[1], 'quarter');
  assert.ok(after.quarterExact < before.quarterExact - 0.1);
  assert.deepEqual(Array.from(setup.subarray(0, ECU_OFF)), Array.from(sd.setups[1].subarray(0, ECU_OFF)));
  assert.ok(Array.from(setup).every((b) => b <= MAX_TUNE_BYTE));
  assert.deepEqual(model.evaluate(setup), after);
});

test('game data: new goals improve fixture acceleration and peak figures without changing gearing', { skip: SKIP_NO_GAME }, () => {
  const game = parseGameData(new Uint8Array(readFileSync(GAME_BUN)));
  const sd = readSlotDyno(load(), 0);
  const model = new DynoModel(game, findCar(game, sd.hash)!, sd.installed, sd.uniques);
  const goals: [DynoGoal, (r: DynoResult) => number, boolean][] = [
    ['accel60', (r) => r.t60, false], ['power', (r) => r.peakPower, true],
    ['torque', (r) => r.peakTorque, true],
  ];
  for (const [goal, metric, higher] of goals) {
    const { setup, before, after } = optimizeSetup(model, sd.setups[1], goal);
    assert.ok(Number.isFinite(metric(after)));
    assert.ok(higher ? metric(after) > metric(before) : metric(after) < metric(before), `${goal} should improve`);
    assert.deepEqual(setup.subarray(0, ECU_OFF), sd.setups[1].subarray(0, ECU_OFF));
    assert.ok(Array.from(setup.subarray(ECU_OFF)).every((b) => b <= MAX_TUNE_BYTE));
    assert.deepEqual(model.evaluate(setup), after);
  }
});

test('game data: optional gearing improves the quarter mile and respects installed tuning unlocks', { skip: SKIP_NO_GAME }, () => {
  const game = parseGameData(new Uint8Array(readFileSync(GAME_BUN)));
  const sd = readSlotDyno(load(), 0);
  const model = new DynoModel(game, findCar(game, sd.hash)!, sd.installed, sd.uniques);
  assert.deepEqual(model.gearingParameters, [9, 10, 11, 12, 13, 14, 15]);
  const curves = optimizeSetup(model, sd.setups[1], 'quarter');
  const result = optimizeSetup(model, curves.setup, 'quarter', true);
  assert.ok(result.after.quarterExact < curves.after.quarterExact);
  assert.ok(diffOffsets(curves.setup, result.setup).some((i) => i >= 9 && i <= 15));
  const allowed = new Set([...model.gearingParameters, ...Array.from({ length: 18 }, (_, i) => ECU_OFF + i)]);
  assert.ok(diffOffsets(curves.setup, result.setup).every((i) => allowed.has(i)));
  assert.deepEqual(model.evaluate(result.setup), result.after);
  for (const goal of ['power', 'torque'] as const) {
    const peak = optimizeSetup(model, sd.setups[1], goal, true);
    assert.deepEqual(peak.setup.subarray(9, 16), sd.setups[1].subarray(9, 16));
  }
  const installed = new Array<boolean>(68).fill(false);
  installed[8] = true;
  const fdOnly = new DynoModel(game, model.car, installed, sd.uniques);
  assert.deepEqual(fdOnly.gearingParameters, [9]);
  const fd = optimizeSetup(fdOnly, sd.setups[1], 'quarter', true);
  assert.ok(diffOffsets(sd.setups[1], fd.setup).every((i) => i === 9));
  installed[8] = false;
  const stock = new DynoModel(game, model.car, installed, sd.uniques);
  assert.deepEqual(stock.gearingParameters, []);
  assert.deepEqual(optimizeSetup(stock, sd.setups[1], 'quarter', true).setup, sd.setups[1]);
  const suv = readSlotDyno(load(), 2);
  const suvModel = new DynoModel(game, findCar(game, suv.hash)!, suv.installed, suv.uniques);
  assert.equal(suvModel.base.gearCount, 5);
  assert.ok(!suvModel.gearingParameters.includes(15));
  const suvResult = optimizeSetup(suvModel, suv.setups[1], 'quarter', true);
  assert.equal(suvResult.setup[15], suv.setups[1][15]);
});

test('controller applies optional gearing and clears proposals when the option changes', { skip: SKIP_NO_GAME }, async (t) => {
  const source = load();
  const bun = new Uint8Array(readFileSync(GAME_BUN));
  function replace(target: object, key: PropertyKey, value: unknown): void {
    const original = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(target, key, original);
      else Reflect.deleteProperty(target, key);
    });
  }
  class TestFileReader {
    result: ArrayBuffer | null = null;
    onload: (() => void) | null = null;
    readAsArrayBuffer(file: File): void {
      this.result = (file.name === 'game.bun' ? bun : source).slice().buffer;
      this.onload?.();
    }
  }
  const downloads: Blob[] = [];
  replace(globalThis, 'FileReader', TestFileReader);
  replace(globalThis, 'fetch', () => Promise.resolve({ ok: true, json: async () => ({}) }));
  replace(globalThis, 'document', {
    createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {} },
  });
  replace(URL, 'createObjectURL', (blob: Blob) => { downloads.push(blob); return 'blob:dyno-test'; });
  replace(URL, 'revokeObjectURL', () => {});
  const scope = {
    $apply(callback: () => void) { callback(); },
    $evalAsync(callback: () => void) { callback(); },
  } as EditorScope;
  EditorController(scope);
  scope.loadFile({ name: 'career' } as File);
  scope.openTuning(0);
  scope.loadGameData({ name: 'game.bun' } as File);
  assert.equal(scope.tuning.dyno.optimizeGearing, false);
  assert.equal(scope.tuning.dyno.gameError, '');
  const game = parseGameData(bun);
  const sd = readSlotDyno(source, 0);
  const model = new DynoModel(game, findCar(game, sd.hash)!, sd.installed, sd.uniques);
  for (const gearing of [false, true]) {
    scope.loadFile({ name: 'career' } as File);
    scope.tuning.dyno.optimizeGearing = gearing;
    scope.setGoal();
    assert.equal(scope.tuning.dyno.hasProposal, false);
    scope.optimizeDyno();
    assert.equal(scope.tuning.dyno.busy, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(scope.tuning.dyno.busy, false);
    assert.equal(scope.tuning.dyno.hasProposal, true);
    const expected = optimizeSetup(model, sd.setups[1], 'quarter', gearing).setup;
    scope.applyDyno();
    scope.download();
    const output = new Uint8Array(await downloads[downloads.length - 1].arrayBuffer());
    assert.deepEqual(output, recalculateChecksums(setSetupTuning(source, 0, 1, expected, gearing)));
    assert.equal(scope.tuning.dyno.hasProposal, false);
  }
  scope.optimizeDyno();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(scope.tuning.dyno.hasProposal, true);
  scope.tuning.dyno.optimizeGearing = false;
  scope.setGoal();
  assert.equal(scope.tuning.dyno.hasProposal, false);
});

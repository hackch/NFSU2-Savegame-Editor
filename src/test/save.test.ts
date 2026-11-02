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
  getCarKey, isCarBought, isSlotUsed, isSlotLinked, isSlotLocked, setSlotCar, setSlotLocked, slotState, swapSlots,
} from '../model/slots.js';
import { countUnlocked, countUnlockedCategory, setUnlocks, setUnlockCategory, UNLOCK_COUNT } from '../model/unlocks.js';
import {
  MAGIC, HEADER_SIZE, SLOT_BASE, SLOT_COUNT, SLOT_STRIDE, SLOT_USED_OFF, PERF_OFF, MONEY_OFF, GARAGE_CAR_COUNT,
  SLOT_LINK_OFF, SLOT_LINK_LEN, SLOT_LOCK_REL, SLOT_BOUGHT_REL, UNIQUE_PERF_OFF,
} from '../model/layout.js';
import { parseCarDatabase, buildCarIndex, identifyCar, type Donor } from '../model/cars.js';

const FIXTURE = fileURLToPath(new URL('../../testfile/treav0r', import.meta.url));
const hasFixture = existsSync(FIXTURE);
const SKIP_NO_FIXTURE = !hasFixture && 'testfile/treav0r missing';
const load = (): Uint8Array => new Uint8Array(readFileSync(FIXTURE));

test('built page includes its version, numeric UTC build stamp and splash label', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.ok(html.includes(`v${version} &middot; Build `));
  assert.match(html, /Build \d{14}<\/span>/);
  assert.ok(html.includes('Now with unique performance parts!'));
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
  let acceptConfirmation = true;
  replaceProperty(globalThis, 'FileReader', TestFileReader);
  replaceProperty(globalThis, 'fetch', () => Promise.resolve({ ok: true, json: async () => ({}) }));
  replaceProperty(globalThis, 'confirm', (message: string) => {
    confirmations.push(message);
    return acceptConfirmation;
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
  scope.setCategory({ ...firstCategory, code: 'AE', parts: [hiddenPart] }, false);
  assert.equal(scope.status.type, 'error');
  assert.deepEqual(payloadDiff(baseline, await snapshot()), []);

  const forgedCategory = { ...firstCategory, parts: [hiddenPart] };
  scope.setCategory(forgedCategory, true);
  const categoryOn = await snapshot();
  const categoryOffsets = firstCategory.parts.filter((part) => part.active).map((part) => perfOffset(0, part.index));
  assert.deepEqual(payloadDiff(baseline, categoryOn), categoryOffsets);
  scope.setCategory(forgedCategory, false);
  assert.deepEqual(payloadDiff(baseline, await snapshot()), []);

  acceptConfirmation = false;
  scope.installAll(0, true);
  assert.deepEqual(payloadDiff(baseline, await snapshot()), []);
  acceptConfirmation = true;

  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    scope.openTuning(slot);
    assert.deepEqual(scope.tuning.categories.map((category) => category.code),
      ['WT', 'TR', 'NO', 'EN', 'TU', 'SU', 'BR', 'EC', 'TI']);
    assert.equal(scope.tuning.categories.flatMap((category) => category.parts).length, 56);
    assert.equal(scope.tuning.categories.filter((category) => category.unique !== null).length, 9);
    const before = await snapshot();
    const expected = TUNING_PERF_INDICES.map((index) => perfOffset(slot, index));
    scope.installAll(slot, true);
    assert.equal(scope.slots[slot].perfCount, 54);
    const enabled = await snapshot();
    assert.deepEqual(payloadDiff(before, enabled), expected);
    scope.installAll(slot, false);
    assert.equal(scope.slots[slot].perfCount, 0);
    const cleared = await snapshot();
    assert.deepEqual(payloadDiff(enabled, cleared), expected);
    assert.deepEqual(payloadDiff(baseline, cleared), []);
  }
  assert.ok(confirmations.some((message) => message.includes('54 active performance part flags')
    && message.includes('Superseded parts')));
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

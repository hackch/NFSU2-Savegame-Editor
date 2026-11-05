import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { nfsu2Crc } from '../model/checksum.js';
import {
  PERF_PARTS, PERF_CATEGORIES, TUNING_PERF_CATEGORIES, TUNING_PERF_INDICES, UNIQUE_PERF_PARTS,
} from '../data/perf-parts.js';
import { EditorController, curveChart } from '../controller/editor-controller.js';
import { TRAFFIC_CARS } from '../data/traffic-cars.js';
import { setSlotTrafficCar } from '../model/slots.js';
import { parseVisualData, readVisual, VISUAL_OFF, VISUAL_COUNT } from '../model/visual.js';
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
  getCarKey, getCarTypeHash, isCarBought, isSlotUsed, isSlotLocked, setSlotCar, setSlotLocked, slotState, swapSlots,
} from '../model/slots.js';
import { countUnlocked, countUnlockedCategory, setUnlocks, setUnlockCategory, UNLOCK_COUNT } from '../model/unlocks.js';
import {
  MAGIC, HEADER_SIZE, SLOT_BASE, SLOT_COUNT, SLOT_STRIDE, SLOT_USED_OFF, PERF_OFF, MONEY_OFF, GARAGE_CAR_COUNT,
  SLOT_LOCK_REL, SLOT_BOUGHT_REL, UNIQUE_PERF_OFF,
  EXTENDED_SAVE_SIZE, EXTRA_SLOT_RECORD_BASE, PROFILE_SIZE, SLOT_RECORD_END_REL, SLOT_RECORD_REL, slotBase, slotCount,
} from '../model/layout.js';
import {
  GARAGE_HEADER_SIZE, GARAGE_SIZE, buildGarage, checkGarage, findBackupProfiles, garageFingerprint, mergeGarage,
  storedGarageFingerprint,
} from '../model/nfsu2-web.js';
import { crc32, readZip, writeZip, type ZipEntry } from '../model/zip.js';
import { parseCarDatabase, buildCarIndex, identifyCar, type Donor } from '../model/cars.js';
import {
  CURVE_POINTS, DynoModel, ECU_OFF, MAX_TUNE_BYTE, NEUTRAL_BYTE, SETUP_SIZE, TUNING_OFF, TURBO_OFF, findCar, optimizeSetup,
  optimizeDynoSetup, parseGameData, readSlotDyno, setSetupCurves, setSetupTuning, setupOffset,
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
  assert.ok(html.includes('Now with full TUNING!'));
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

test('dyno uses the selected event strategy instead of a goal slider', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(!html.includes('tuning.dyno.goal'));
  assert.ok(html.includes('tuning.dyno.strategy'));
  assert.ok(!html.includes('<option value="quarter">'));
  assert.ok(html.includes('ng-model="tuning.dyno.optimizeGearing"'));
});

test('event tuning prefers usable power over peak HP and guards final refinement', () => {
  const car = { index: 0, name: 'Multi-pass test', hash: 1, view: new DataView(new ArrayBuffer(0x780)) };
  const game = { cars: [car], packages: [],
    tuning: [{ item: 48, level: 1, param: 23, type: 1, f8: -0.06, fC: 0.03 }] };
  const installed = new Array<boolean>(68).fill(false);
  installed[48] = true;
  class PassModel extends DynoModel {
    override tuningBand() {
      return { minRpm: 3000, maxRpm: 7000, description: 'Test band' };
    }
    override usablePower(setup: ArrayLike<number>): number {
      const b = setup[ECU_OFF];
      return b === 40 ? 1000 : b === 180 ? 950 : 800;
    }
    override evaluate(setup: ArrayLike<number>): DynoResult {
      const b = setup[ECU_OFF], time = b >= 160 ? 1 : 10;
      return { t60: time, t100: 2 * time, quarterMile: 3 * time, quarterExact: 3 * time,
        topSpeed: 100 / time, trapSpeed: 80 / time,
        peakPower: b === 10 ? 10000 : 1000, peakPowerRpm: 6000,
        peakTorque: 1000, peakTorqueRpm: 4000 };
    }
  }
  const model = new PassModel(game, car, installed, new Array<number>(9).fill(0));
  const setup = new Uint8Array(SETUP_SIZE).fill(100);
  const original = setup.slice();
  for (const preference of [0, 1, 2, 3, 4] as const) {
    const result = optimizeDynoSetup(model, setup, preference, false);
    assert.equal(result.stages.power.t60, 10);
    assert.equal(result.stages.goal.t60, 1);
    assert.equal(result.stages.goal.peakPower, 1000);
    assert.equal(model.usablePower(result.setup), 950);
    assert.equal(result.setup[ECU_OFF], 180);
    for (const metric of ['t60', 't100', 'quarterMile', 'quarterExact'] as const) {
      assert.ok(result.after[metric] <= result.stages.goal[metric]);
    }
    for (const metric of ['topSpeed', 'trapSpeed'] as const) assert.ok(result.after[metric] >= result.stages.goal[metric]);
    assert.deepEqual(result.before, model.evaluate(setup));
    assert.deepEqual(result.after, model.evaluate(result.setup));
    assert.equal(result.band.minRpm, 3000);
    assert.deepEqual(diffOffsets(setup, result.setup), [ECU_OFF]);
    assert.deepEqual(setup, original);
  }
  for (const metric of ['t60', 't100', 'quarterMile', 'quarterExact', 'topSpeed', 'trapSpeed'] as const) {
    class RegressionModel extends PassModel {
      override evaluate(setup: ArrayLike<number>): DynoResult {
        const result = super.evaluate(setup);
        if (setup[ECU_OFF] === 180) {
          result[metric] += metric === 'topSpeed' || metric === 'trapSpeed' ? -1e-6 : 1e-6;
        }
        return result;
      }
    }
    const guarded = new RegressionModel(game, car, installed, new Array<number>(9).fill(0));
    const result = optimizeDynoSetup(guarded, setup, 1, false);
    assert.ok(result.after[metric] === result.stages.goal[metric], `${metric}: reject even a small regression`);
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
  for (const slot of [-1, 10, 0.5, NaN]) {
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

test('swapping slots keeps native record handles and does not touch the next record', () => {
  const data = new Uint8Array(0xd300);
  data.forEach((_, i) => { data[i] = i & 0xff; });
  const once = swapSlots(data, 0, 4);
  const allowed = new Set<number>();
  for (const slot of [0, 4]) {
    for (let rel = 0; rel < SLOT_RECORD_END_REL; rel++) allowed.add(SLOT_BASE + slot * SLOT_STRIDE + rel);
  }
  assert.deepEqual(diffOffsets(data, once).filter((offset) => !allowed.has(offset)), []);
  assert.deepEqual(once.subarray(SLOT_BASE + SLOT_RECORD_REL, SLOT_BASE), data.subarray(SLOT_BASE + SLOT_RECORD_REL, SLOT_BASE));
  assert.throws(() => swapSlots(data, 0, 5), RangeError);
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
  source[SLOT_BASE + SLOT_BOUGHT_REL] = 1;
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
  assert.equal(scope.replacementCars.length, donors.length + TRAFFIC_CARS.length);
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
  for (const car of TRAFFIC_CARS) {
    const choice = scope.replacementCars.find((option) => option.id === `traffic:${car.hash}`);
    assert.ok(choice?.experimental);
    assert.equal(choice.group, 'Traffic cars (experimental)');
    scope.replaceTarget[0] = choice.id;
    scope.replaceCar(0);
    assert.equal(scope.slots[0].trafficName, car.name);
    assert.equal(scope.slots[0].car, null);
    assert.equal(scope.status.type, 'success');
    scope.openTuning(0);
    assert.match(scope.tuning.dyno.blocked, /unavailable.*traffic/);
  }
  replace(globalThis, 'confirm', () => { assert.fail('Traffic replacement must not ask for confirmation.'); });
  scope.replaceTarget[0] = `traffic:${TRAFFIC_CARS[0].hash}`;
  scope.replaceCar(0);
  assert.equal(scope.slots[0].trafficName, TRAFFIC_CARS[0].name);
  replace(globalThis, 'confirm', () => true);
  scope.replaceTarget[0] = donorNamed('Hyundai Tiburon GT').id;
  scope.replaceCar(0);
  assert.equal(scope.slots[0].trafficName, '');
  assert.equal(scope.slots[0].car?.name, 'Hyundai Tiburon GT');
});

test('experimental traffic writes only the identity of filled unlocked slots', () => {
  const source = new Uint8Array(0xd300);
  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    source[SLOT_BASE + slot * SLOT_STRIDE + SLOT_USED_OFF] = 1;
    source[SLOT_BASE + slot * SLOT_STRIDE + SLOT_BOUGHT_REL] = 1;
  }
  assert.equal(TRAFFIC_CARS.length, 15);
  assert.equal(new Set(TRAFFIC_CARS.map((car) => car.hash)).size, 15);
  for (const car of TRAFFIC_CARS) {
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      const out = setSlotTrafficCar(source, slot, car.hash);
      assert.equal(getCarTypeHash(out, slot), car.hash);
      assert.ok(diffOffsets(source, out).every((off) =>
        off >= SLOT_BASE + slot * SLOT_STRIDE + 0x14 && off < SLOT_BASE + slot * SLOT_STRIDE + 0x18));
      assert.equal(getCarTypeHash(source, slot), 0);
      assert.deepEqual(verifyChecksums(recalculateChecksums(out)), { blockA: true, blockB: true, header: true });
    }
  }
  assert.throws(() => setSlotTrafficCar(source, 0, 0), /Unknown traffic/);
  assert.throws(() => setSlotTrafficCar(setSlotLocked(source, 0, true), 0, TRAFFIC_CARS[0].hash), /filled/);
  const open = source.slice();
  open[SLOT_BASE + SLOT_BOUGHT_REL] = 0;
  assert.throws(() => setSlotTrafficCar(open, 0, TRAFFIC_CARS[0].hash), /filled/);
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

test('fixture: empty slot 5 becomes a bought car without copying another car appearance', { skip: SKIP_NO_FIXTURE }, () => {
  const data = load();
  assert.equal(data[GARAGE_CAR_COUNT], 4);
  const out = setSlotCar(data, 4, donorNamed('Mazda Miata MX5'));
  assert.equal(isSlotUsed(out, 4), true);
  assert.equal(identifyCar(carIndex, getCarTypeHash(out, 4))?.name, 'Mazda Miata MX5');
  assert.equal(out[GARAGE_CAR_COUNT], 5);
  assert.ok(readVisual(out, 4).slice(153, 163).every((hash) => hash === 0));
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

test('setSlotCar can fill the first car without an appearance template', () => {
  const data = new Uint8Array(0xd300);
  const out = setSlotCar(data, 0, donors[0]);
  assert.equal(isCarBought(out, 0), true);
  assert.equal(getCarTypeHash(out, 0), donors[0].hash);
  assert.ok(readVisual(out, 0).slice(153, 163).every((hash) => hash === 0));
});

test('replacement clears old appearance, all stickers and neon in every career and web slot', () => {
  const data = new Uint8Array(EXTENDED_SAVE_SIZE).fill(0xa5);
  const original = data.slice();
  for (let slot = 0; slot < 10; slot++) {
    const base = slotBase(slot), clean = data.slice();
    clean.fill(0, base + VISUAL_OFF, base + VISUAL_OFF + VISUAL_COUNT * 4);
    for (const donor of donors) {
      const out = setSlotCar(data, slot, donor);
      const fromClean = setSlotCar(clean, slot, donor);
      assert.deepEqual(out, fromClean, `${slot}:${donor.name}: old appearance must not survive`);
      const refs = readVisual(out, slot);
      for (const [first, end] of [[64,68], [77,93], [97,153], [153,163]]) {
        assert.ok(refs.slice(first, end).every((hash) => hash === 0), `${slot}:${donor.name}:${first}`);
      }
      assert.deepEqual(out.subarray(base + 0x354, base + 0x354 + 5 * 41),
        data.subarray(base + 0x354, base + 0x354 + 5 * 41), 'dyno setups kept');
      assert.equal(slotState(out, slot), 'filled');
      assert.equal(getCarTypeHash(out, slot), donor.hash);
      assert.ok(diffOffsets(data, out).every((i) =>
        i >= base && i < base + SLOT_RECORD_END_REL || i === GARAGE_CAR_COUNT), 'only target record changes');
    }
  }
  assert.deepEqual(data, original, 'input remains unchanged');
});

test('replacement clears stickers and neon even when present in donor variants', () => {
  const donor = donorNamed('Toyota Supra');
  const bytes = new Uint8Array(VISUAL_COUNT * 4).fill(0xa5);
  const withGraphics: Donor = { ...donor, blocks: [...donor.blocks, { off: SLOT_BASE + VISUAL_OFF, bytes }] };
  const out = setSlotCar(new Uint8Array(PROFILE_SIZE), 0, withGraphics), refs = readVisual(out, 0);
  for (const [first, end] of [[64,68], [77,93], [97,153], [154,159]]) {
    assert.ok(refs.slice(first, end).every((hash) => hash === 0));
  }
  assert.equal(refs[63], 0xa5a5a5a5, 'donor paint is retained');
  assert.ok(bytes.every((b) => b === 0xa5), 'donor not mutated');
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
  // These values predate the native corrections of PR #4: they come from the earlier traced reference model
  // (technical.md, "Dyno tuning"), not from the game. The evidence for the model is now src/test/dyno-exactness.test.ts (the game executable's own results).
  // Regenerate this table from the corrected model with `node scripts/fixture-dyno.mjs`; the case inputs it also
  // prints are numbers only and can be run through the game executable for independent values.
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

test('shift power windows integrate every RPM recovery band in five and six speed gearboxes', () => {
  for (const count of [5, 6]) {
    const view = new DataView(new ArrayBuffer(0x780));
    view.setInt32(0x1c8, count, true);
    view.setFloat32(0x1f0, 1000, true);
    view.setFloat32(0x1f4, 6000, true);
    view.setFloat32(0x1f8, 7000, true);
    for (let i = 0; i < count; i++) view.setFloat32(0x1d8 + i * 4, 4 * 0.75 ** i, true);
    for (let i = 0; i < 9; i++) view.setFloat32(0x200 + i * 4, 0.3, true);
    const car = { index: 0, name: 'Power window test', hash: 1, view };
    const model = new DynoModel({ cars: [car], packages: [], tuning: [] }, car,
      new Array<boolean>(68).fill(false), new Array<number>(9).fill(0));
    const setup = new Uint8Array(SETUP_SIZE).fill(100);
    const original = setup.slice();
    const windows = model.gearPowerWindows(setup);
    assert.equal(windows.length, count - 1);
    for (const [i, window] of windows.entries()) {
      assert.equal(window.fromGear, i + 1);
      assert.equal(window.retention, 0.75);
      assert.equal(window.shiftRpm, 5800);
      assert.equal(window.landingRpm, 4350);
      // Constant torque gives power linear in RPM; the game's peak sampler stops at 6950. The peak is sampled in
      // float32 (FUN_005b56e0), so the ratio is exact only to float32 precision.
      assert.ok(Math.abs(window.powerCoverage - 5075 / 6950) < 1e-6);
    }
    const band = { minRpm: 2500, maxRpm: 5500, description: 'Analytic constant-torque band' };
    const expected = Math.fround(0.3) * 0.10471204 * Math.cbrt(3000 * 4000 * 5000);
    assert.ok(Math.abs(model.usablePower(setup, band) - expected) < 1e-9, 'geometric mean of integrated sub-bands');
    const bands = ([0, 1, 2, 3, 4] as const).map((event) => model.tuningBand(setup, event));
    assert.equal(bands[0].minRpm, 4350, 'circuit starts at actual shift recovery');
    assert.equal(bands[2].minRpm, 2200);
    assert.equal(bands[2].maxRpm, 5500);
    assert.equal(bands[3].minRpm, 2500);
    assert.equal(bands[3].maxRpm, 6100);
    assert.equal(bands[1].maxRpm, 7000);
    assert.deepEqual(bands[0].minRpm, bands[4].minRpm);
    assert.throws(() => model.usablePower(setup, { ...band, minRpm: band.maxRpm }), /positive width/);
    assert.deepEqual(setup, original);
  }
});

test('gearing optimization repairs a second-to-third hole even when the timed goal prefers it', () => {
  const view = new DataView(new ArrayBuffer(0x780));
  view.setInt32(0x1c8, 5, true);
  for (const [off, value] of [[0x1b8, 4], [0x1bc, 4], [0x3d8, 4], [0x50, 0.3], [0x80, 0.3],
    [0x1f0, 1000], [0x1f4, 6000], [0x1f8, 7000]]) view.setFloat32(off, value, true);
  [3.5, 2.1, 1.5, 1.1, 0.85].forEach((value, i) => view.setFloat32(0x1d8 + i * 4, value, true));
  for (let i = 0; i < 9; i++) view.setFloat32(0x200 + i * 4, 0.3, true);
  const car = { index: 0, name: 'Shift hole test', hash: 1, view };
  const tuning = [[-0.2, 0.4], [-0.8, 1], [-0.6, 0.8], [-0.4, 0.6], [-0.3, 0.4], [-0.1, 0.25]]
    .map(([f8, fC], i) => ({ item: 11, level: 3, param: 9 + i, type: 1, f8, fC }));
  const installed = new Array<boolean>(68).fill(false);
  installed[11] = true;
  class ShortRunModel extends DynoModel {
    override evaluate(setup: ArrayLike<number>): DynoResult {
      return { t60: 1 + (200 - setup[11] + setup[12]) * 0.0001, t100: 2, quarterMile: 3,
        quarterExact: 3, topSpeed: 100, trapSpeed: 80, peakTorque: 300, peakTorqueRpm: 5000,
        peakPower: 200, peakPowerRpm: 6000 };
    }
  }
  const model = new ShortRunModel({ cars: [car], packages: [], tuning }, car, installed,
    new Array<number>(9).fill(0));
  const neutral = new Uint8Array(SETUP_SIZE).fill(100);
  const bad = neutral.slice();
  bad[11] = 200;
  bad[12] = 0;
  const original = bad.slice();
  const before = model.gearPowerWindows(bad);
  const reference = model.gearPowerWindows(neutral);
  const result = optimizeSetup(model, bad, 'accel60', true);
  const after = model.gearPowerWindows(result.setup);
  const even = reference.reduce((product, window) => product * window.retention, 1) ** (1 / reference.length);
  assert.ok(before[1].retention < Math.min(reference[1].retention, even) - 0.1);
  assert.ok(after[1].retention > before[1].retention + 0.1);
  assert.ok(Math.min(...after.map((window) => window.powerCoverage)) >
    Math.min(...before.map((window) => window.powerCoverage)));
  for (const [i, window] of after.entries()) {
    assert.ok(window.retention >= Math.min(reference[i].retention, even) - 1e-6);
  }
  assert.ok(diffOffsets(bad, result.setup).every((idx) => model.gearingParameters.includes(idx)));
  assert.deepEqual(bad, original);
  assert.deepEqual(result.after, model.evaluate(result.setup));
  assert.deepEqual(optimizeSetup(model, bad, 'accel60', false).setup, bad);
  class NoBudgetModel extends ShortRunModel {
    override evaluate(setup: ArrayLike<number>): DynoResult {
      return { ...super.evaluate(setup), t60: setup[11] === 200 && setup[12] === 0 ? 1 : 2 };
    }
  }
  const noBudget = new NoBudgetModel(model.game, car, installed, new Array<number>(9).fill(0));
  assert.throws(() => optimizeSetup(noBudget, bad, 'accel60', true), /No smooth gearing setup.*5%/);
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

test('game data: optional gearing balances all-shift power with performance and respects tuning unlocks', { skip: SKIP_NO_GAME }, () => {
  const game = parseGameData(new Uint8Array(readFileSync(GAME_BUN)));
  const sd = readSlotDyno(load(), 0);
  const model = new DynoModel(game, findCar(game, sd.hash)!, sd.installed, sd.uniques);
  assert.deepEqual(model.gearingParameters, [9, 10, 11, 12, 13, 14, 15]);
  const curves = optimizeSetup(model, sd.setups[1], 'quarter');
  const result = optimizeSetup(model, curves.setup, 'quarter', true);
  const beforeWindows = model.gearPowerWindows(curves.setup);
  const afterWindows = model.gearPowerWindows(result.setup);
  assert.ok(Math.min(...afterWindows.map((window) => window.powerCoverage)) >
    Math.min(...beforeWindows.map((window) => window.powerCoverage)) + 0.1);
  const dispersion = (windows: ReturnType<DynoModel['gearPowerWindows']>) => {
    const gaps = windows.map((window) => -Math.log(window.retention));
    const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
    return gaps.reduce((sum, gap) => sum + (gap - mean) ** 2, 0) / gaps.length / mean ** 2;
  };
  assert.ok(dispersion(afterWindows) < dispersion(beforeWindows) * 0.5);
  const goalScore = (r: DynoResult) => r.quarterExact * 1000 + r.t100 - r.topSpeed * 1e-3;
  assert.ok(goalScore(result.after) <= goalScore(curves.after) * 1.05 + 1e-9);
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
  for (let slot = 1; slot < 4; slot++) {
    const sd = readSlotDyno(load(), slot);
    const other = new DynoModel(game, findCar(game, sd.hash)!, sd.installed, sd.uniques);
    const optimized = slot === 2 ? suvResult : optimizeSetup(other, sd.setups[1], 'quarter', true);
    const neutral = sd.setups[1].slice();
    for (const idx of other.gearingParameters) neutral[idx] = 100;
    const windows = other.gearPowerWindows(optimized.setup);
    const reference = other.gearPowerWindows(neutral);
    const even = reference.reduce((product, window) => product * window.retention, 1) ** (1 / reference.length);
    assert.equal(windows.length, other.base.gearCount - 1);
    for (const [i, window] of windows.entries()) {
      assert.ok(window.retention >= Math.min(reference[i].retention, even) - 1e-6, `${other.car.name}, shift ${i + 1}`);
    }
    assert.ok(dispersion(windows) < dispersion(reference), `${other.car.name}: more even RPM drops`);
    assert.ok(goalScore(optimized.after) <= goalScore(optimized.before) * 1.05 + 1e-9, `${other.car.name}: performance budget`);
  }
});

test('game data: event tuning protects final times and speeds for all five modes', { skip: SKIP_NO_GAME }, () => {
  const game = parseGameData(new Uint8Array(readFileSync(GAME_BUN)));
  for (const slot of [0, 2]) {
    const sd = readSlotDyno(load(), slot);
    const model = new DynoModel(game, findCar(game, sd.hash)!, sd.installed, sd.uniques);
    const original = sd.setups[1].slice();
    for (const preference of [0, 1, 2, 3, 4] as const) {
      const result = optimizeDynoSetup(model, sd.setups[1], preference, true);
      const label = `${model.car.name}/${preference}`;
      assert.ok(model.usablePower(result.setup, result.band) >= model.usablePower(original, result.band) - 1e-6);
      for (const metric of ['t60', 't100', 'quarterMile', 'quarterExact'] as const) {
        assert.ok(Number.isFinite(result.after[metric]));
        assert.ok(result.after[metric] <= result.stages.goal[metric], `${label}/${metric}`);
      }
      for (const metric of ['topSpeed', 'trapSpeed'] as const) {
        assert.ok(result.after[metric] >= result.stages.goal[metric], `${label}/${metric}`);
      }
      const allowed = new Set([...model.gearingParameters, ...Array.from({ length: 18 }, (_, i) => ECU_OFF + i)]);
      assert.ok(diffOffsets(original, result.setup).every((idx) => allowed.has(idx)));
      assert.deepEqual(sd.setups[1], original);
      assert.deepEqual(result.after, model.evaluate(result.setup));
    }
  }
});

test('game data: ECU and turbo curves match the game byte mapping', { skip: SKIP_NO_GAME }, () => {
  const game = parseGameData(new Uint8Array(readFileSync(GAME_BUN)));
  const sd = readSlotDyno(load(), 0);
  const model = new DynoModel(game, findCar(game, sd.hash)!, sd.installed, sd.uniques);
  const neutral = sd.setups[1].slice().fill(NEUTRAL_BYTE, ECU_OFF);
  for (const kind of ['ecu', 'turbo'] as const) {
    const points = model.curve(neutral, kind);
    assert.ok(points, kind);
    assert.equal(points.length, CURVE_POINTS);
    for (const [i, p] of points.entries()) {
      const label = `${kind}/${i}`;
      assert.ok(p.min <= p.max, label);
      assert.ok(Math.abs(p.value - Math.min(Math.max(p.stock, p.min), p.max)) < 1e-6, `${label}: neutral is stock`);
      assert.ok(p.minByte <= p.maxByte, label);
      if (i) assert.ok(p.rpm > points[i - 1].rpm, label);
      const off = (kind === 'ecu' ? ECU_OFF : TURBO_OFF) + i;
      const at = (byte: number) => model.curve(Object.assign(neutral.slice(), { [off]: byte }), kind)![i].value;
      const span = p.max - p.min, byteStep = span / 100 + 1e-6;
      const lowest = Math.min(Math.max(p.min, p.stock - span), p.max), highest = Math.max(Math.min(p.max, p.stock + span), p.min);
      assert.ok(Math.abs(at(p.minByte) - lowest) < byteStep, `${label}: min byte`);
      assert.ok(Math.abs(highest - at(p.maxByte)) < byteStep, `${label}: max byte`);
      if (p.minByte > 0) assert.ok(at(p.minByte - 1) - p.min < 1e-6, `${label}: no lower useful byte`);
      if (p.maxByte < MAX_TUNE_BYTE) assert.ok(p.max - at(p.maxByte + 1) < 1e-6, `${label}: no higher useful byte`);
      assert.equal(DynoModel.curveByte(p, p.max + 1000), p.maxByte);
      assert.equal(DynoModel.curveByte(p, p.min - 1000), p.minByte);
      assert.equal(DynoModel.curveByte(p, p.value), Math.min(Math.max(NEUTRAL_BYTE, p.minByte), p.maxByte));
    }
  }
  const stock = new DynoModel(game, findCar(game, sd.hash)!, new Array<boolean>(sd.installed.length).fill(false), sd.uniques);
  assert.equal(stock.curve(neutral, 'turbo'), null, 'no turbo curve without a turbo part');

  // Game tuning screen (FUN_005b2c00): ±1 neighbours follow by 25%, ±2–±4 give back 25% each, so the sum is kept.
  const sumOf = (pts: { value: number }[]) => pts.reduce((t, p) => t + p.value, 0);
  const before = model.curve(neutral, 'ecu')!;
  const raise = (before[4].max - before[4].min) * 0.1;
  const edited = model.withCurvePoint(neutral, 'ecu', 4, before[4].value + raise);
  for (let i = 0; i < ECU_OFF; i++) assert.equal(edited[i], neutral[i], 'only curve bytes change');
  for (let i = TURBO_OFF; i < neutral.length; i++) assert.equal(edited[i], neutral[i], 'turbo is untouched');
  const after = model.curve(edited, 'ecu')!;
  assert.ok(after[4].value > before[4].value, 'point rises');
  for (const i of [3, 5]) assert.ok(after[i].value >= before[i].value, `neighbour ${i} follows`);
  assert.ok([0, 1, 2, 6, 7, 8].some((i) => after[i].value < before[i].value), 'far points give back');
  const byteSum = before.reduce((t, p) => t + (p.max - p.min) / 100, 0);
  assert.ok(Math.abs(sumOf(after) - sumOf(before)) < byteSum, 'sum kept within byte rounding');
  assert.ok(after.every((p) => Math.abs(p.effective - p.value) < byteSum / 9 + 1e-6), 'little left for the load to spread');
  const top = model.withCurvePoint(neutral, 'ecu', 0, 1e9);
  assert.equal(top[ECU_OFF], model.curve(neutral, 'ecu')![0].maxByte, 'clamped to the range');

  // Save-only cheat: lowering one point alone makes the load spread the loss over all nine.
  const cheat = neutral.slice();
  cheat[ECU_OFF] = before[0].minByte;
  const spread = model.curve(cheat, 'ecu')!;
  const shift = (before[0].value - spread[0].value) / 9;
  assert.ok(shift > 0);
  const base = before[0].effective - before[0].value, offset = spread[0].effective - spread[0].value - base;
  for (const p of spread) assert.ok(Math.abs(p.effective - p.value - base - offset) < 1e-6, 'even spread');
  // The neutral load can skip a small pre-existing sum difference below the restore threshold.
  assert.ok(offset >= shift - 1e-6, 'spread covers the lowered point');
  assert.ok(spread[1].effective > spread[1].value, 'other points end up above their set values');
  for (const unique of [-1, 3, 4, 7]) {
    const uniques = new Array<number>(9).fill(0);
    if (unique >= 0) uniques[unique] = 1;
    const m = new DynoModel(game, findCar(game, sd.hash)!, sd.installed, uniques);
    const physics = m.tuned(cheat);
    const ecu = m.curve(cheat, 'ecu')!, turbo = m.curve(cheat, 'turbo')!;
    for (let i = 0; i < CURVE_POINTS; i++) {
      const total = physics.f[(0x200 + i * 4) >> 2] * 1000;
      const boost = physics.f[(0x224 + i * 4) >> 2] * 1000;
      assert.ok(Math.abs(ecu[i].effective - total + boost) < 1e-9, `unique ${unique}: actual loaded ECU`);
      assert.equal(turbo[i].effective, boost, `unique ${unique}: actual loaded turbo`);
      assert.ok(Math.abs(ecu[i].effective + turbo[i].effective - total) < 1e-9, 'components reconstruct loaded torque');
      if (unique < 0) {
        // FUN_005b2c00 writes a point back only when its request differs from the current value, so a neutral
        // byte keeps a stock point that lies outside the clamped range (e.g. above the power cap) unclamped.
        const kept = cheat[TURBO_OFF + i] === NEUTRAL_BYTE && (turbo[i].stock > turbo[i].max || turbo[i].stock < turbo[i].min);
        const want = kept ? turbo[i].stock : turbo[i].value;
        assert.ok(Math.abs(turbo[i].effective - want) < 1e-3, `turbo/${i}: no invented turbo sum correction`);
      }
    }
  }
});

test('game data: drivetrain rows follow the game gear speed and range clamps', { skip: SKIP_NO_GAME }, () => {
  const game = parseGameData(new Uint8Array(readFileSync(GAME_BUN)));
  const sd = readSlotDyno(load(), 0);
  const model = new DynoModel(game, findCar(game, sd.hash)!, sd.installed, sd.uniques);
  const neutral = sd.setups[1].slice().fill(NEUTRAL_BYTE, 9, 16);
  const gearing = model.gearing(neutral)!;
  assert.deepEqual(gearing.rows.map((r) => r.param), [10, 11, 12, 13, 14, 15, 9], 'gears first, final drive last');
  const p = model.tuned(neutral), f = (off: number) => p.f[off >> 2];
  const bias = f(0x1c0);
  const wheel = bias < 0.2 ? f(0x50) : bias > 0.8 ? f(0x80) : f(0x80) * bias + (1 - bias) * f(0x50);
  for (const r of gearing.rows) {
    assert.ok(Math.abs(r.ratio - r.stock) < 1e-6, `${r.label}: neutral is stock`);
    assert.ok(r.min <= r.ratio && r.ratio <= r.max, r.label);
    if (r.speed === null) continue;
    // FUN_0059b5c0 uses the float constant stored at 0x7A1D38 (bytes 44 77 D6 3D = 0.10471966862678528), not the
    // power factor 0.10471204, and computes in float32; compare in double with a float32-sized relative tolerance.
    const kmh = wheel * f(0x1f4) * 0.10471966862678528 / (f(0x1b8) * r.ratio) * 3.6;
    assert.ok(Math.abs(r.speed - kmh) <= kmh * 1e-6, `${r.label}: FUN_0059b5c0 speed`);
    assert.ok(r.minSpeed! <= r.speed && r.speed <= r.maxSpeed!, r.label);
  }
  const fd = gearing.rows[6];
  const at = (byte: number) => model.gearing(Object.assign(neutral.slice(), { 9: byte }))!.rows[6].ratio;
  assert.equal(at(255), at(MAX_TUNE_BYTE), 'bytes above 200 decode like 200');
  assert.equal(at(MAX_TUNE_BYTE), fd.max, 'final drive clamps to its range');
  const highFd = model.withGearRatio(neutral, 9, fd.max + 5);
  assert.ok(Math.abs(model.gearing(highFd)!.rows[6].ratio - fd.max) < (fd.max - fd.min) / 100);
  assert.ok(model.gearing(highFd)!.rows[0].speed! < gearing.rows[0].speed!, 'shorter final drive lowers gear speeds');
  const third = gearing.rows[2];
  const short = model.gearing(model.withGearRatio(neutral, 12, third.max))!;
  assert.ok(Math.abs(short.rows[2].ratio - third.max) < (third.max - third.min) / 100);
  for (let i = 1; i < 6; i++) assert.ok(short.rows[i - 1].ratio - short.rows[i].ratio > 0.049, `gear ${i} keeps the spacing`);
  assert.ok(short.rows[1].ratio > gearing.rows[1].ratio, '3rd pushes 2nd up');
  for (const r of gearing.rows) {
    assert.deepEqual(model.withGearRatio(neutral, r.param, r.ratio), neutral, `${r.label}: same ratio keeps the bytes`);
  }
  const stock = new DynoModel(game, findCar(game, sd.hash)!, new Array<boolean>(sd.installed.length).fill(false), sd.uniques);
  assert.equal(stock.gearing(neutral), null, 'no drivetrain without transmission parts');
});

test('controller applies optional gearing and edits ECU/turbo drafts', { skip: SKIP_NO_GAME }, async (t) => {
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
    assert.equal(scope.tuning.dyno.hasProposal, false);
    scope.optimizeDyno();
    assert.equal(scope.tuning.dyno.busy, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(scope.tuning.dyno.busy, false);
    assert.equal(scope.tuning.dyno.hasProposal, true);
    assert.ok(scope.tuning.dyno.strategy.startsWith('Drag:'));
    const optimized = optimizeDynoSetup(model, sd.setups[1], 1, gearing);
    const expected = optimized.setup;
    const bandRow = scope.tuning.dyno.rows.find((row) => row.label === 'Usable band power')!;
    assert.equal(bandRow.before.metric, `${model.usablePower(sd.setups[1], optimized.band).toFixed(1)} kW`);
    assert.equal(bandRow.after!.metric, `${model.usablePower(expected, optimized.band).toFixed(1)} kW`);
    assert.deepEqual(scope.tuning.dyno.chart!.columns.length, CURVE_POINTS);
    assert.equal(scope.tuning.dyno.curve, 'ecu');
    assert.ok(Math.abs(model.curve(expected, 'ecu')![0].value
      - (scope.tuning.dyno.chart!.bottom - scope.tuning.dyno.chart!.columns[0].valueY)
      / (scope.tuning.dyno.chart!.bottom - scope.tuning.dyno.chart!.top) * scope.tuning.dyno.chart!.yMax) < 1e-6,
    'graph shows the auto-tuned draft');
    scope.applyDyno();
    scope.download();
    const output = new Uint8Array(await downloads[downloads.length - 1].arrayBuffer());
    assert.deepEqual(output, recalculateChecksums(setSetupTuning(source, 0, 1, expected, gearing)));
    assert.equal(scope.tuning.dyno.hasProposal, false);
  }
  // Changing the optional gearing setting keeps the draft; discard drops it.
  scope.optimizeDyno();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(scope.tuning.dyno.hasProposal, true);
  scope.tuning.dyno.optimizeGearing = !scope.tuning.dyno.optimizeGearing;
  assert.equal(scope.tuning.dyno.hasProposal, true);
  scope.discardDyno();
  assert.equal(scope.tuning.dyno.hasProposal, false);

  // Manual graph edits: step, keys, pointer, reset, apply.
  scope.loadFile({ name: 'career' } as File);
  scope.openTuning(0);
  assert.deepEqual(scope.tuning.dyno.curveTabs.map((tab) => tab.kind),
    ['ecu', 'turbo', 'drive', 'suspension', 'aerodynamics', 'tires-brakes', 'nitrous']);
  assert.equal(scope.tuning.dyno.cheat, false, 'game tuning-screen rules by default');
  scope.tuning.dyno.cheat = true;
  scope.selectCurve('turbo');
  scope.selectPoint(4);
  const turbo = model.curve(sd.setups[1], 'turbo')!;
  const step = turbo[4].byte < turbo[4].maxByte ? 1 : -1;
  scope.stepPoint(step);
  assert.equal(scope.tuning.dyno.hasProposal, true);
  const expected = sd.setups[1].slice();
  expected[TURBO_OFF + 4] = Math.min(Math.max(turbo[4].byte, turbo[4].minByte), turbo[4].maxByte) + step;
  scope.stepPoint(-step);
  assert.equal(scope.tuning.dyno.hasProposal, false, 'stepping back to the saved byte drops the draft');
  scope.stepPoint(step);
  const keyEvent = (key: string, shiftKey = false) => ({ key, shiftKey, preventDefault() {} }) as unknown as KeyboardEvent;
  scope.curveKey(keyEvent('ArrowLeft'));
  assert.equal(scope.tuning.dyno.point, 3);
  scope.curveKey(keyEvent('ArrowUp', true));
  const p3 = turbo[3];
  expected[TURBO_OFF + 3] = Math.min(Math.min(Math.max(p3.byte, p3.minByte), p3.maxByte) + 10, p3.maxByte);
  const chart = scope.tuning.dyno.chart!;
  const svg = { getBoundingClientRect: () => ({ left: 0, top: 0, width: chart.width, height: chart.height }) };
  const pointer = (x: number, y: number, buttons: number) =>
    ({ clientX: x, clientY: y, buttons, currentTarget: svg, preventDefault() {} }) as unknown as MouseEvent;
  scope.curvePointer(pointer(chart.columns[8].x + 1, chart.top, 0), false);
  assert.equal(scope.tuning.dyno.point, 3, 'moving without a button does nothing');
  scope.curvePointer(pointer(chart.columns[8].x + 1, chart.top, 1), true);
  assert.equal(scope.tuning.dyno.point, 8);
  expected[TURBO_OFF + 8] = turbo[8].maxByte;
  scope.selectCurve('ecu');
  scope.tuning.dyno.cheat = false;
  scope.selectPoint(4);
  const ecu = model.curve(expected, 'ecu')!;
  const ecuStep = ecu[4].byte < ecu[4].maxByte ? 1 : -1;
  scope.stepPoint(ecuStep);
  const gameRule = model.withCurvePoint(expected, 'ecu', 4,
    DynoModel.curveValue(ecu[4], Math.min(Math.max(ecu[4].byte, ecu[4].minByte), ecu[4].maxByte) + ecuStep));
  assert.deepEqual(scope.tuning.dyno.chart, curveChart(model.curve(gameRule, 'ecu')!, 4), 'game rules move the neighbours too');
  scope.resetCurve();
  expected.fill(NEUTRAL_BYTE, ECU_OFF, TURBO_OFF);
  assert.equal(scope.tuning.dyno.hasProposal, !sameSetup(expected, sd.setups[1]));
  scope.applyDyno();
  scope.download();
  const output = new Uint8Array(await downloads[downloads.length - 1].arrayBuffer());
  assert.deepEqual(output, recalculateChecksums(setSetupTuning(source, 0, 1, expected)));
  assert.equal(scope.tuning.dyno.hasProposal, false);

  // Drivetrain: step, keys, pointer, reset, apply.
  scope.loadFile({ name: 'career' } as File);
  scope.openTuning(0);
  scope.selectCurve('drive');
  assert.equal(scope.tuning.dyno.chart, null);
  const drive = scope.tuning.dyno.drive!;
  assert.deepEqual(drive.rows.map((r) => r.label), ['1st gear', '2nd gear', '3rd gear', '4th gear', '5th gear', '6th gear', 'Final drive']);
  const saved = sd.setups[1];
  const byteRatio = (setup: Uint8Array, index: number, byteDelta: number) => {
    const r = model.gearing(setup)!.rows[index], span = r.max - r.min;
    return r.stock + span * (Math.round(100 + 100 * (r.ratio - r.stock) / span) + byteDelta - 100) / 100;
  };
  scope.selectGear(0);
  scope.stepGear(1);
  let gearExpected = model.withGearRatio(saved, 10, byteRatio(saved, 0, -1));
  assert.ok(model.gearing(gearExpected)!.rows[0].speed! > model.gearing(saved)!.rows[0].speed!, '+ makes 1st faster');
  assert.equal(scope.tuning.dyno.hasProposal, true);
  scope.gearKey(keyEvent('ArrowDown'));
  assert.equal(scope.tuning.dyno.gear, 1);
  scope.gearKey(keyEvent('ArrowLeft', true));
  gearExpected = model.withGearRatio(gearExpected, 11, byteRatio(gearExpected, 1, 10));
  const bar = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 12 }) };
  const barEvent = (x: number, buttons: number) =>
    ({ clientX: x, clientY: 0, buttons, currentTarget: bar, preventDefault() {} }) as unknown as MouseEvent;
  scope.gearPointer(barEvent(300, 1), 6, false);
  assert.equal(scope.tuning.dyno.gear, 1, 'dragging over another row does nothing');
  scope.gearPointer(barEvent(300, 1), 6, true);
  assert.equal(scope.tuning.dyno.gear, 6);
  gearExpected = model.withGearRatio(gearExpected, 9, model.gearing(gearExpected)!.rows[6].max);
  assert.equal(scope.tuning.dyno.drive!.selected.canUp, false, 'final drive at its Acceleration end');
  scope.resetCurve();
  assert.equal(scope.tuning.dyno.hasProposal, !sameSetup(Object.assign(saved.slice(), { 9: 100, 10: 100, 11: 100, 12: 100, 13: 100, 14: 100, 15: 100 }), saved));
  scope.gearKey(keyEvent('ArrowUp'));
  scope.gearKey(keyEvent('ArrowUp'));
  assert.equal(scope.tuning.dyno.gear, 4);
  scope.stepGear(1);
  scope.gearPointer(barEvent(300, 1), 6, true);
  scope.applyDyno();
  scope.download();
  const neutralGears = saved.slice().fill(NEUTRAL_BYTE, 9, 16);
  gearExpected = model.withGearRatio(neutralGears, 14, byteRatio(neutralGears, 4, -1));
  gearExpected = model.withGearRatio(gearExpected, 9, model.gearing(gearExpected)!.rows[6].max);
  const gearOutput = new Uint8Array(await downloads[downloads.length - 1].arrayBuffer());
  assert.deepEqual(gearOutput, recalculateChecksums(setSetupTuning(source, 0, 1, gearExpected, true)));

  for (const kind of ['suspension', 'aerodynamics', 'tires-brakes', 'nitrous'] as const) {
    scope.loadFile({ name: 'career' } as File);
    scope.selectCurve(kind);
    assert.equal(scope.tuning.dyno.chart, null);
    assert.equal(scope.tuning.dyno.drive, null);
    const row = scope.tuning.dyno.scalars[0];
    assert.ok(row.editable, kind);
    scope.editScalar(row, row.minByte);
    const expected = model.withScalarValue(sd.setups[1], row.param, row.min);
    scope.download();
    assert.deepEqual(new Uint8Array(await downloads.at(-1)!.arrayBuffer()), recalculateChecksums(source),
      'scalar draft does not change saved bytes before Apply');
    scope.applyDyno();
    scope.download();
    assert.deepEqual(new Uint8Array(await downloads.at(-1)!.arrayBuffer()),
      recalculateChecksums(setSetupTuning(source, 0, 1, expected, false, true)));
  }

  scope.loadFile({ name: 'career' } as File);
  scope.selectTab('GRAPHICS');
  const paint = scope.tuning.visual.groups.flatMap((g) => g.rows).find((row) => row.id === 63)!;
  assert.equal(paint.colorPicker, true);
  assert.equal(paint.palettes.length, 9);
  assert.equal(paint.palettes.flatMap((p) => p.swatches).length, 150);
  assert.ok(!paint.palettes.some((p) => /HOSES|MUFFLERS/.test(p.name)));
  const hoses = scope.tuning.visual.groups.flatMap((g) => g.rows).find((row) => row.id === 68)!;
  assert.equal(hoses.palettes.flatMap((p) => p.swatches).length, 60);
  assert.ok(hoses.palettes.every((p) => p.name.startsWith('HOSES_')));
  paint.value = paint.palettes.flatMap((p) => p.swatches).find((p) => p.hash !== paint.value)!.hash;
  scope.editVisual(paint);
  assert.equal(scope.tuning.visual.hasProposal, true);
  const selectedPaint = scope.tuning.visual.groups.flatMap((g) => g.rows).find((row) => row.id === 63)!;
  assert.equal(selectedPaint.value, paint.value);
  assert.equal(selectedPaint.selectedLabel, paint.palettes.flatMap((p) => p.swatches).find((p) => p.hash === paint.value)!.name);
  scope.selectTab('SPECIALTIES');
  assert.ok(scope.tuning.visual.groups.some((g) => g.label === 'Dials'));
  scope.download();
  assert.deepEqual(new Uint8Array(await downloads.at(-1)!.arrayBuffer()), recalculateChecksums(source),
    'visual draft does not change saved bytes before Apply');
  scope.applyVisual();
  scope.download();
  const catalog = parseVisualData(bun, game.cars);
  const visualExpected = catalog.edit(source, 0, 63, paint.value);
  assert.deepEqual(new Uint8Array(await downloads.at(-1)!.arrayBuffer()), recalculateChecksums(visualExpected));
  assert.equal(scope.tuning.visual.hasProposal, false);
  scope.selectTab('GRAPHICS');
  const repaint = scope.tuning.visual.groups.flatMap((g) => g.rows).find((row) => row.id === 63)!;
  repaint.value = 0;
  scope.editVisual(repaint);
  scope.discardVisual();
  assert.equal(scope.tuning.visual.hasProposal, false);
  scope.download();
  assert.deepEqual(new Uint8Array(await downloads.at(-1)!.arrayBuffer()), recalculateChecksums(visualExpected));
});

function sameSetup(a: Uint8Array, b: Uint8Array): boolean {
  return a.every((byte, i) => byte === b[i]);
}

function syntheticCareer(seed: number): Uint8Array {
  const data = new Uint8Array(PROFILE_SIZE);
  const view = new DataView(data.buffer);
  data.set(MAGIC);
  view.setUint16(4, data.length & 0xffff, true);
  view.setUint32(8, data.length - HEADER_SIZE, true);
  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    const base = slotBase(slot);
    view.setUint32(base + SLOT_RECORD_REL + 4, 0x319a8ca1 + slot, true);
    view.setUint16(base + SLOT_USED_OFF, 1, true);
    data[base + SLOT_BOUGHT_REL] = 1;
    data[base + 0x100] = seed + slot;
  }
  return recalculateChecksums(data);
}

function syntheticGarage(career: Uint8Array, seed = 0x60): Uint8Array {
  const garage = new Uint8Array(GARAGE_SIZE);
  const view = new DataView(garage.buffer);
  garage.set([0x4e, 0x32, 0x47, 0x41]);
  view.setUint32(4, 1, true);
  view.setUint32(16, 0x319a8ca6, true);
  view.setUint32(24, 0x319a8ca1, true);
  for (let i = 0; i < 5; i++) {
    const rec = GARAGE_HEADER_SIZE + i * SLOT_STRIDE;
    view.setUint32(rec + 4, 0x319a8ca6 + i, true);
    view.setUint16(rec - SLOT_RECORD_REL + SLOT_USED_OFF, 1, true);
    garage[rec - SLOT_RECORD_REL + SLOT_LOCK_REL] = i === 0 ? 0 : 1;
    garage[rec - SLOT_RECORD_REL + SLOT_BOUGHT_REL] = i === 0 ? 1 : 0;
    garage[rec - SLOT_RECORD_REL + 0x100] = seed + i;
  }
  return buildGarage(garage, mergeGarageUnchecked(career, garage), career);
}

function mergeGarageUnchecked(career: Uint8Array, garage: Uint8Array): Uint8Array {
  const out = new Uint8Array(EXTENDED_SAVE_SIZE);
  out.set(career);
  out.set(garage.subarray(GARAGE_HEADER_SIZE), EXTRA_SLOT_RECORD_BASE);
  return out;
}

function zipEntry(name: string, data: Uint8Array, time = 0x7700, date = 0x5b61): ZipEntry {
  return { name, data, time, date, utf8: true, versionMadeBy: 0x031e, internalAttributes: 0, externalAttributes: 0x81a40000 };
}

test('stored ZIP round trip keeps metadata, reads deflate and rejects bad CRCs', async () => {
  const archive = { comment: new TextEncoder().encode('backup'), entries: [
    zipEntry('NFS Underground 2/Zoë/Zoë', new Uint8Array([1, 2, 3])),
    zipEntry('settings.ini', new TextEncoder().encode('x=1\n'), 0x1234, 0x5678),
  ] };
  const bytes = writeZip(archive);
  assert.deepEqual(await readZip(bytes), archive);

  const plain = new TextEncoder().encode('deflated '.repeat(20));
  const stream = new Blob([plain]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  const stored = writeZip({ comment: new Uint8Array(), entries: [zipEntry('a.txt', compressed)] });
  const deflated = new Uint8Array(stored.length);
  deflated.set(stored);
  const view = new DataView(deflated.buffer);
  const central = view.getUint32(deflated.length - 6, true);
  view.setUint16(8, 8, true);
  view.setUint32(14, crc32(plain), true);
  view.setUint32(22, plain.length, true);
  view.setUint16(central + 10, 8, true);
  view.setUint32(central + 16, crc32(plain), true);
  view.setUint32(central + 24, plain.length, true);
  assert.deepEqual((await readZip(deflated)).entries[0].data, plain);

  const damaged = bytes.slice();
  damaged[30 + new TextEncoder().encode(archive.entries[0].name).length] ^= 1;
  await assert.rejects(readZip(damaged), /CRC/);
});

test('nfsu2-web GARAGE.DAT pairs by car-part fingerprint and maps slots 6-10', () => {
  const career = syntheticCareer(0x20);
  const garage = syntheticGarage(career);
  assert.equal(storedGarageFingerprint(garage), garageFingerprint(career));
  assert.equal(checkGarage(garage, career).state, 'loaded');
  const merged = mergeGarage(career, garage);
  assert.equal(slotCount(merged), 10);
  assert.equal(slotCount(career), 5);
  assert.equal(slotBase(5), EXTRA_SLOT_RECORD_BASE - SLOT_RECORD_REL);
  assert.equal(merged[slotBase(5) + 0x100], 0x60);
  assert.equal(merged[slotBase(9) + 0x100], 0x64);
  assert.equal(slotState(merged, 5), 'filled');
  assert.equal(slotState(merged, 6), 'locked');
  assert.equal(slotBase(9) + SLOT_RECORD_END_REL, EXTENDED_SAVE_SIZE);

  const swapped = swapSlots(merged, 0, 5);
  assert.equal(swapped[slotBase(0) + 0x100], 0x60);
  assert.equal(swapped[slotBase(5) + 0x100], 0x20);
  assert.equal(new DataView(swapped.buffer).getUint32(slotBase(5) + SLOT_RECORD_REL + 4, true), 0x319a8ca6);
  const changedCareer = recalculateChecksums(swapped.slice(0, PROFILE_SIZE));
  const rebuilt = buildGarage(garage, swapped, changedCareer);
  assert.notEqual(garageFingerprint(changedCareer), garageFingerprint(career));
  assert.equal(storedGarageFingerprint(rebuilt), garageFingerprint(changedCareer));
  assert.deepEqual(rebuilt.subarray(16, 32), garage.subarray(16, 32));
  assert.equal(rebuilt[GARAGE_HEADER_SIZE - SLOT_RECORD_REL + 0x100], 0x20);
  assert.equal(checkGarage(garage, changedCareer).state, 'stale');
  const bad = garage.slice();
  bad[4] = 2;
  assert.equal(checkGarage(bad, career).state, 'invalid');
});

test('nfsu2-web backup profiles report loaded, stale and missing garages', () => {
  const a = syntheticCareer(1);
  const b = syntheticCareer(2);
  const c = syntheticCareer(3);
  const profiles = findBackupProfiles([
    zipEntry('NFS Underground 2/A/A', a), zipEntry('NFS Underground 2/A/GARAGE.DAT', syntheticGarage(a)),
    zipEntry('NFS Underground 2/B/B', b), zipEntry('NFS Underground 2/B/garage.dat', syntheticGarage(c)),
    zipEntry('NFS Underground 2/C/C', c), zipEntry('settings.ini', new Uint8Array([1])),
  ]);
  assert.deepEqual(profiles.map((p) => [p.name, p.garageState]), [['A', 'loaded'], ['B', 'stale'], ['C', 'missing']]);
});

test('controller edits nfsu2-web ZIP profiles and preserves unrelated entries', async (t) => {
  const a = syntheticCareer(1);
  const b = syntheticCareer(2);
  const garage = syntheticGarage(a);
  const original = writeZip({ comment: new Uint8Array([7]), entries: [
    zipEntry('NFS Underground 2/A/GARAGE.DAT', garage, 1, 2),
    zipEntry('NFS Underground 2/A/GARAGE.OLD', new Uint8Array([9]), 3, 4),
    zipEntry('NFS Underground 2/A/A', a, 5, 6),
    zipEntry('NFS Underground 2/B/B', b, 7, 8),
    zipEntry('settings.ini', new TextEncoder().encode('# keep\n'), 9, 10),
  ] });
  function replace(target: object, key: PropertyKey, value: unknown): void {
    const old = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (old) Object.defineProperty(target, key, old);
      else Reflect.deleteProperty(target, key);
    });
  }
  let input = original;
  class TestFileReader {
    result: ArrayBuffer | null = null;
    onload: (() => void) | null = null;
    readAsArrayBuffer(): void {
      this.result = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer;
      this.onload?.();
    }
  }
  const downloads: Blob[] = [];
  replace(globalThis, 'FileReader', TestFileReader);
  replace(globalThis, 'fetch', () => Promise.resolve({ ok: true, json: async () => ({}) }));
  replace(globalThis, 'confirm', () => true);
  replace(globalThis, 'document', { createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {} } });
  replace(URL, 'createObjectURL', (blob: Blob) => { downloads.push(blob); return 'blob:zip-test'; });
  const scope = { $apply(callback: () => void) { callback(); }, $evalAsync(callback: () => void) { callback(); } } as EditorScope;
  EditorController(scope);
  scope.loadFile({ name: 'nfsu2-saves.zip' } as File);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(scope.loaded, true);
  assert.equal(scope.slots.length, 10);
  assert.deepEqual(scope.backup?.profiles.map((p) => p.label), ['A (10 slots)', 'B (5 slots)']);

  scope.toggleLock(6);
  assert.equal(scope.slots[6].locked, false);
  scope.swapTarget[0] = 5;
  scope.swapSlots(0);
  scope.selectProfile(1);
  assert.equal(scope.slots.length, 5);
  scope.form.name = 'B';
  scope.form.money = 12345;
  scope.applyProfile();
  scope.selectProfile(0);
  assert.equal(scope.slots[6].locked, false);
  scope.download();
  const output = await readZip(new Uint8Array(await downloads[0].arrayBuffer()));
  const source = await readZip(original);
  assert.deepEqual(output.comment, source.comment);
  assert.deepEqual(output.entries.map((e) => e.name), source.entries.map((e) => e.name));
  for (const index of [1, 4]) assert.deepEqual(output.entries[index], source.entries[index]);
  const outA = output.entries[2].data;
  const outGarage = output.entries[0].data;
  const outB = output.entries[3].data;
  assert.deepEqual(verifyChecksums(outA), { blockA: true, blockB: true, header: true });
  assert.equal(storedGarageFingerprint(outGarage), garageFingerprint(outA));
  assert.equal(outGarage[GARAGE_HEADER_SIZE + SLOT_STRIDE - SLOT_RECORD_REL + SLOT_LOCK_REL], 0);
  assert.equal(outA[slotBase(0) + 0x100], 0x60);
  assert.equal(outGarage[GARAGE_HEADER_SIZE - SLOT_RECORD_REL + 0x100], 1);
  assert.equal(getMoney(outB), 12345);
  assert.notDeepEqual([output.entries[2].time, output.entries[2].date], [5, 6]);

  input = garage;
  scope.loadFile({ name: 'GARAGE.DAT' } as File);
  assert.equal(scope.loaded, false);
  assert.match(scope.status.text, /Load the backup ZIP/);
});

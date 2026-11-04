import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  DynoModel, SETUP_SIZE, parseGameData, setSetupTuning, setupOffset,
  type CarRecord, type GameData,
} from '../model/dyno.js';

const neutral = () => new Uint8Array(SETUP_SIZE).fill(100);
const close = (actual: number, expected: number, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const at = (model: DynoModel, setup: Uint8Array, off: number) => model.tuned(setup).f[off >> 2];

function fixture() {
  const view = new DataView(new ArrayBuffer(0x780));
  const put = (off: number, value: number) => view.setFloat32(off, value, true);
  for (const [off, value] of [
    [0x174, 20], [0x194, 30], [0x5c4, 40], [0x5e4, 50],
    [0x178, 4], [0x17c, 6], [0x198, 5], [0x19c, 7],
    [0x5c8, 8], [0x5cc, 10], [0x5e8, 9], [0x5ec, 11],
    [0x180, 10], [0x1a0, 12], [0x5d0, 20], [0x5f0, 22],
    [0x18, 0.3], [0x48, 0.31], [0x78, 0.35], [0xa8, 0.36],
    [0x604, 0.04], [0x608, 0.05], [0x270, 1], [0x5bc, 1.5],
    [0x2a0, 6], [0x2ac, 0.5], [0x27c, 0.55],
    [0xdc, 1], [0xe0, 1.2], [0xfc, 1.1], [0x100, 1.3],
    [0x54c, 1.8], [0x550, 2], [0x56c, 1.9], [0x570, 2.1],
    [0x264, 0.1], [0x268, 0.2], [0x590, 0.1], [0x594, 0.1],
  ]) put(off, value);
  const car: CarRecord = { index: 0, hash: 123, name: 'Test', view };
  const scalarParams = [...Array.from({ length: 9 }, (_, i) => i), 16, 17, 18, 19, 20, 21, 22];
  const tuning = scalarParams.map((param) => ({
    item: param, level: 1, param,
    type: param >= 16 && param <= 18 ? 4 : param === 8 ? 1 : 2,
    f8: param === 16 ? 1 : param === 17 ? 0.1 : param === 18 ? 0.25 : -0.2,
    fC: param === 16 ? 11 : param === 17 ? 0.9 : param === 18 ? 0.75 : 0.1,
    displayMin: param === 18 ? -1 : param < 3 || param >= 19 ? 0 : -99.99,
    displayMax: param === 18 ? 1 : param < 3 || param >= 19 ? 10 : -99.99,
  }));
  const game: GameData = { cars: [car], packages: [], tuning };
  const installed = new Array<boolean>(68).fill(true);
  return { model: new DynoModel(game, car, installed, new Array<number>(9).fill(0)), game, car, installed };
}

test('scalar rows cover all 16 non-gear controls and honor installed record unlocks', () => {
  const { model, game, car } = fixture();
  const setup = neutral(), rows = model.scalarTuning(setup);
  assert.deepEqual(rows.map((r) => r.param), [0, 1, 2, 3, 4, 5, 6, 7, 8, 16, 17, 18, 19, 20, 21, 22]);
  assert.deepEqual(new Set(rows.map((r) => r.category)), new Set(['suspension', 'nitrous', 'tires-brakes', 'aerodynamics']));
  assert.equal(new DynoModel(game, car, Array(68).fill(false), Array(9).fill(0)).scalarTuning(setup).length, 0);
  for (const row of rows) {
    assert.ok(row.min < row.max);
    assert.ok(row.minByte >= 0 && row.maxByte <= 200);
    assert.ok(row.minByte <= row.maxByte);
    assert.ok(Number.isFinite(row.displayValue));
  }
});

test('non-nitrous scalar edits preserve every unrelated byte and do not mutate inputs', () => {
  const { model } = fixture();
  for (const row of model.scalarTuning(neutral()).filter((r) => r.param !== 16 && r.param !== 17)) {
    const setup = neutral();
    setup[24] = 37;
    setup[40] = 233;
    const before = setup.slice();
    const out = model.withScalarValue(setup, row.param, row.min);
    assert.deepEqual(setup, before);
    for (let i = 0; i < SETUP_SIZE; i++) if (i !== row.param) assert.equal(out[i], setup[i]);
    const edited = model.scalarTuning(out).find((r) => r.param === row.param)!;
    close(edited.value, row.min, (row.max - row.min) * 0.011);
  }
});

test('fractional type-2 ranges use shared front/rear reference defaults', () => {
  const { model } = fixture();
  const rows = model.scalarTuning(neutral());
  const spring = rows.find((r) => r.param === 0)!;
  // Absolute 20..50 expands to 14..53; upper limit is max(default front,rear) + 10% of 39.
  close(spring.min, 14);
  close(spring.max, 33.9);
  const rear = rows.find((r) => r.param === 4)!;
  close(rear.max, spring.max);
  close(spring.displayMin, 0);
  close(spring.displayMax, 10 * (33.9 - 14) / 39);
});

test('shocks and tire grip map the average control into both component ranges', () => {
  const { model } = fixture();
  for (const [param, offsets] of [[1, [0x178, 0x17c]], [5, [0x198, 0x19c]],
    [19, [0xdc, 0xe0]], [20, [0xfc, 0x100]]] as const) {
    const row = model.scalarTuning(neutral()).find((r) => r.param === param)!;
    const setup = model.withScalarValue(neutral(), param, row.min);
    const actual = model.scalarTuning(setup).find((r) => r.param === param)!;
    const average = offsets.reduce((sum, off) => sum + at(model, setup, off), 0) / 2;
    close(average, actual.value);
    assert.notEqual(at(model, setup, offsets[0]), at(model, setup, offsets[1]));
  }
});

test('ride height is a negative displacement from each original wheel position, displayed in cm', () => {
  const { model } = fixture();
  const row = model.scalarTuning(neutral()).find((r) => r.param === 3)!;
  const setup = model.withScalarValue(neutral(), 3, row.min);
  const value = model.scalarTuning(setup).find((r) => r.param === 3)!.value;
  close(at(model, setup, 0x18), model.car.view.getFloat32(0x18, true) - value);
  close(at(model, setup, 0x48), model.car.view.getFloat32(0x48, true) - value);
  close(row.displayValue, row.value * 100);
  assert.equal(row.unit, 'cm');
});

test('nitrous duration and flow are inverse-coupled and both edits survive a setup reload', () => {
  const { model } = fixture();
  for (const param of [16, 17]) {
    const rows = model.scalarTuning(neutral()), row = rows.find((r) => r.param === param)!;
    const out = model.withScalarValue(neutral(), param, row.max);
    for (let i = 0; i < SETUP_SIZE; i++) if (i !== 16 && i !== 17) assert.equal(out[i], 100);
    const result = model.scalarTuning(out), changed = result.find((r) => r.param === param)!;
    close(changed.value, row.max, (row.max - row.min) * 0.011);
    assert.ok(out[16] !== 100 && out[17] !== 100);
    close((at(model, out, 0x2a0) - 6) / 10 + (at(model, out, 0x2ac) - 0.5) / 0.8, 0);
  }
  const raw = neutral();
  raw[17] = 150;
  close(at(model, raw, 0x2ac), 0.5); // Load applies duration first and re-encodes the flow byte.
});

test('scalar physics setters target steering, brake bias and independent front/rear aero fields', () => {
  const { model } = fixture();
  for (const [param, off] of [[8, 0x270], [18, 0x27c], [21, 0x264], [22, 0x268]]) {
    const row = model.scalarTuning(neutral()).find((r) => r.param === param)!;
    const setup = model.withScalarValue(neutral(), param, row.min);
    close(at(model, setup, off), model.scalarTuning(setup).find((r) => r.param === param)!.value);
  }
});

test('type-3 scalar records use fractional lower and upper offsets', () => {
  const { game, car, installed } = fixture();
  game.tuning = [{ item: 0, level: 1, param: 0, type: 3, f8: -0.1, fC: 0.2 }];
  const row = new DynoModel(game, car, installed, Array(9).fill(0)).scalarTuning(neutral())[0];
  // Absolute bounds 17..56, own default 20 (rear is locked and has zero reference default).
  close(row.min, 17);
  close(row.max, 27.8);
});

test('scalar defaults include installed suspension, nitrous, brakes, tires and aero packages', () => {
  const { game, car, installed } = fixture();
  car.view.setFloat32(0x580, 9, true);
  car.view.setFloat32(0x58c, 0.6, true);
  car.view.setFloat32(0x5b8, 0.45, true);
  game.packages = [2, 5, 6, 8, 9].map((category) => ({
    category, level: 1, subs: [{ item: 60, fractions: [1, 1, 1, 1] }],
  }));
  const model = new DynoModel(game, car, installed, Array(9).fill(0));
  const rows = model.scalarTuning(neutral());
  close(rows.find((r) => r.param === 0)!.stock, 40);
  close(rows.find((r) => r.param === 1)!.stock, 9);
  close(rows.find((r) => r.param === 3)!.stock, -0.04);
  close(rows.find((r) => r.param === 8)!.stock, 1.5);
  close(rows.find((r) => r.param === 16)!.stock, 9);
  close(rows.find((r) => r.param === 17)!.stock, 0.6);
  close(rows.find((r) => r.param === 18)!.stock, 0.45);
  close(rows.find((r) => r.param === 19)!.stock, 1.9);
  close(rows.find((r) => r.param === 21)!.stock, 0.2);
  close(rows.find((r) => r.param === 22)!.stock, 0.3);
});

test('unique nitrous, brakes and tire effects apply after tuning without changing control defaults', () => {
  const { game, car, installed } = fixture();
  for (const [off, value] of [[0x2b8, 0.04], [0x2bc, 0.1],
    [0x2c0, 0.2], [0x2c8, 0.3], [0x2c4, 0.4], [0x2cc, 0.5]]) {
    car.view.setFloat32(off, value, true);
  }
  const unique = Array<number>(9).fill(0);
  unique[2] = unique[6] = unique[8] = 1;
  const model = new DynoModel(game, car, installed, unique);
  const plain = new DynoModel(game, car, installed, Array(9).fill(0));
  assert.deepEqual(model.scalarTuning(neutral()), plain.scalarTuning(neutral()));
  for (const [off, delta] of [[0x2ac, 0.04], [0x274, 0.1],
    [0xdc, 0.2], [0xe0, 0.3], [0xfc, 0.4], [0x100, 0.5]]) {
    close(at(model, neutral(), off) - at(plain, neutral(), off), delta);
  }
});

test('saving scalars is opt-in and legacy curve/gearing writes retain their boundaries', () => {
  const off = setupOffset(0, 0), save = new Uint8Array(off + SETUP_SIZE + 20).fill(77);
  const setup = Uint8Array.from({ length: SETUP_SIZE }, (_, i) => i + 1);
  const curves = setSetupTuning(save, 0, 0, setup);
  const scalars = setSetupTuning(save, 0, 0, setup, false, true);
  const all = setSetupTuning(save, 0, 0, setup, true, true);
  for (let i = 0; i < SETUP_SIZE; i++) {
    assert.equal(curves[off + i], i >= 23 ? setup[i] : 77);
    assert.equal(scalars[off + i], i >= 9 && i <= 15 ? 77 : setup[i]);
    assert.equal(all[off + i], setup[i]);
  }
  assert.ok(save.every((v) => v === 77));
  assert.deepEqual(all.subarray(0, off), save.subarray(0, off));
  assert.deepEqual(all.subarray(off + SETUP_SIZE), save.subarray(off + SETUP_SIZE));
});

test('scalar API rejects invalid setups, nonfinite values, locked and unknown parameters', () => {
  const { model } = fixture();
  assert.throws(() => model.scalarTuning(new Uint8Array(40)), /41 bytes/);
  assert.throws(() => model.withScalarValue(neutral(), 0, NaN), /finite/);
  assert.throws(() => model.withScalarValue(neutral(), 0, Infinity), /finite/);
  assert.throws(() => model.withScalarValue(neutral(), 9, 1), /locked or unknown/);
  assert.throws(() => model.withScalarValue(neutral(), 23, 1), /locked or unknown/);
});

const gamePath = process.env.NFSU2_GLOBALB
  ?? 'C:\\Program Files (x86)\\EA GAMES\\Need for Speed Underground 2\\GLOBAL\\GLOBALB.BUN';

test('local game data: every car has finite editable controls, correct display scales and physical setters',
  { skip: !existsSync(gamePath) && 'Local GLOBALB.BUN unavailable' }, () => {
    const game = parseGameData(readFileSync(gamePath));
    for (const car of game.cars) {
      const model = new DynoModel(game, car, Array(68).fill(true), Array(9).fill(0));
      const rows = model.scalarTuning(neutral());
      assert.equal(rows.length, 16, car.name);
      for (const row of rows) {
        assert.ok(Number.isFinite(row.value) && Number.isFinite(row.displayValue), `${car.name}: ${row.param}`);
        if (!row.editable) {
          assert.ok(car.index >= 31, `${car.name}: playable-car bounds must be valid`);
          assert.throws(() => model.withScalarValue(neutral(), row.param, row.min), /invalid bounds/);
          continue;
        }
        const out = model.withScalarValue(neutral(), row.param, row.min);
        const edited = model.scalarTuning(out).find((r) => r.param === row.param)!;
        close(edited.value, row.min, (row.max - row.min) * 0.021);
        assert.ok(edited.value >= row.min - 1e-6 && edited.value <= row.max + 1e-6);
      }
    }
  });

test('local game data: scalar controls do not invent effects in the straight-line dyno simulation',
  { skip: !existsSync(gamePath) && 'Local GLOBALB.BUN unavailable' }, () => {
    const game = parseGameData(readFileSync(gamePath)), car = game.cars[0];
    const model = new DynoModel(game, car, Array(68).fill(true), Array(9).fill(0));
    const baseline = model.evaluate(neutral());
    for (const row of model.scalarTuning(neutral())) {
      assert.deepEqual(model.evaluate(model.withScalarValue(neutral(), row.param, row.min)), baseline, row.label);
    }
  });

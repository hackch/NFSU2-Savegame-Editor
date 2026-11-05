import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { DynoModel, findCar, parseGameData } from '../model/dyno.js';

// Reference values come from the unmodified game executable (SPEED2.EXE, sha256 f9dd86c0...68a7) run in a CPU
// emulator that calls only its tuning-load and dyno functions (FUN_005b06a0 and the functions it uses). The fixture
// holds numbers only (car type hash, installed bytes, uniques, setup bytes, unrounded results). The test needs the
// game's GLOBALB.BUN, like the other game-data tests.
const GAME_BUN = process.env.NFSU2_GLOBALB ?? 'C:/Program Files (x86)/EA GAMES/Need for Speed Underground 2/GLOBAL/GLOBALB.BUN';
const SKIP = !existsSync(GAME_BUN) && 'GLOBALB.BUN (set NFSU2_GLOBALB) missing';

interface Expected {
  t60: number | null; t100: number | null; quarterMile: number | null; trapMph: number | null; topMph: number;
  peakTorqueNm: number; peakPowerKw: number; peakPowerRpm: number; gearCount: number; peakTorqueRpm?: number;
}
interface Case { hash: number; installed: number[]; uniques: number[]; setup: number[]; expected: Expected }

const fixture = JSON.parse(readFileSync(new URL('../../src/test/fixtures/dyno-exactness.json', import.meta.url), 'utf8')) as { cases: Case[] };

test('dyno model reproduces the game executable on 40 reference cases', { skip: SKIP }, () => {
  const game = parseGameData(new Uint8Array(readFileSync(GAME_BUN)));
  fixture.cases.forEach((c, i) => {
    const car = findCar(game, c.hash >>> 0);
    assert.ok(car, `case ${i}: unknown car ${c.hash}`);
    const model = new DynoModel(game, car, c.installed.map((b) => b !== 0), c.uniques);
    const r = model.evaluate(c.setup);
    const e = c.expected;
    const near = (name: string, actual: number, expected: number | null, tol: number): void => {
      if (expected === null) assert.ok(!Number.isFinite(actual), `case ${i} ${name}: expected unreachable, got ${actual}`);
      else assert.ok(Math.abs(actual - expected) <= tol, `case ${i} ${name}: ${actual} != ${expected}`);
    };
    near('t60', r.t60, e.t60, 1e-6);
    near('t100', r.t100, e.t100, 1e-6);
    near('quarterMile', r.quarterMile, e.quarterMile, 1e-6);
    near('trapMph', r.trapSpeed, e.trapMph, 1e-3);
    near('topMph', r.topSpeed, e.topMph, 2e-3);
    near('peakTorque', r.peakTorque, e.peakTorqueNm, 1e-3);
    near('peakPower', r.peakPower, e.peakPowerKw, 1e-3);
    assert.equal(r.peakPowerRpm, e.peakPowerRpm, `case ${i} peakPowerRpm`);
    // Peak-torque rpm is only listed where it is unambiguous (flat-curve ties are not asserted).
    if (e.peakTorqueRpm !== undefined) assert.equal(r.peakTorqueRpm, e.peakTorqueRpm, `case ${i} peakTorqueRpm`);
  });
});

test('interactive gear writer encodes bytes with the float32 writer of the load', { skip: SKIP }, () => {
  // Peugeot 106, all non-visual performance parts, no uniques, neutral setup: the native float32 writer gives 82.
  const game = parseGameData(new Uint8Array(readFileSync(GAME_BUN)));
  const car = findCar(game, 0x4b10070a);
  assert.ok(car, 'Peugeot 106 type hash');
  const installed = [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,
    1,1,1,1,1,1,1,0,1,0,0,1,0,0,1,0,0,1,0].map((b) => b !== 0);
  const model = new DynoModel(game, car, installed, new Array<number>(9).fill(0));
  const neutral = new Uint8Array(41).fill(100);
  assert.equal(model.withGearRatio(neutral, 9, 3.2168500423431396)[9], 82);
  // Writing back an unclamped ratio that a byte decodes to reproduces the same gearing, for every such byte of
  // every unlocked row. (A ratio clamped to its range limit re-encodes from the range edge, as in the game.)
  for (const row of model.gearing(neutral)!.rows) {
    for (let b = 0; b <= 200; b++) {
      const setup = neutral.slice();
      setup[row.param] = b;
      const cur = model.gearing(setup)!.rows.find((r) => r.param === row.param)!;
      const ratio = cur.ratio;
      if (ratio - cur.min < 1e-6 || cur.max - ratio < 1e-6) continue;
      const again = model.withGearRatio(setup, row.param, ratio);
      assert.deepEqual(model.gearing(again)!.rows.map((r) => r.ratio), model.gearing(setup)!.rows.map((r) => r.ratio),
        `${row.label} byte ${b}`);
    }
  }
});

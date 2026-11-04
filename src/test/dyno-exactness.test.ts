import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { DynoModel, findCar, parseGameData } from '../model/dyno.js';

// Reference values come from the game executable run in an emulator (see docs/upstream-issue.md); the fixture
// holds numbers only. The test needs the game's GLOBALB.BUN, like the other game-data tests.
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

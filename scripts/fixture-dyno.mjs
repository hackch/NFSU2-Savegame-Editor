// Prints the dyno values of the fixture save for the golden table in save.test.ts
// ("game data: dyno matches the traced reference model on the fixture"), plus the case inputs as numbers only
// (car type hash, installed bytes, uniques, setup bytes), in the format of src/test/fixtures/dyno-exactness.json.
// The case inputs contain no game data, so they can be shared to obtain the game executable's own results.
// Usage: npm run build && NFSU2_GLOBALB=<path> node scripts/fixture-dyno.mjs [save=testfile/treav0r] [setup=1]
import { readFileSync } from 'node:fs';
import { DynoModel, findCar, parseGameData, readSlotDyno } from '../dist/model/dyno.js';

const bunPath = process.env.NFSU2_GLOBALB;
if (!bunPath) throw new Error('Set NFSU2_GLOBALB to your GLOBALB.BUN.');
const savePath = process.argv[2] ?? 'testfile/treav0r';
const setupIndex = Number(process.argv[3] ?? 1);
const game = parseGameData(new Uint8Array(readFileSync(bunPath)));
const save = new Uint8Array(readFileSync(savePath));
const round = (x) => Number(x.toFixed(6));
const golden = [], cases = [];
for (let slot = 0; slot < 4; slot++) {
  const sd = readSlotDyno(save, slot);
  const car = findCar(game, sd.hash);
  if (!car) break;
  const r = new DynoModel(game, car, sd.installed, sd.uniques).evaluate(sd.setups[setupIndex]);
  golden.push(`    { name: '${car.name}', t60: ${round(r.t60)}, t100: ${round(r.t100)}, qm: ${round(r.quarterMile)}, `
    + `trap: ${round(r.trapSpeed)}, top: ${round(r.topSpeed)}, kw: ${round(r.peakPower)}, nm: ${round(r.peakTorque)} },`);
  cases.push({ hash: sd.hash >>> 0, installed: sd.installed.map((b) => (b ? 1 : 0)), uniques: Array.from(sd.uniques),
    setup: Array.from(sd.setups[setupIndex]) });
}
console.log('// golden table (current model)\n  const golden = [\n' + golden.join('\n') + '\n  ];');
console.log('\n// case inputs (numbers only)\n' + JSON.stringify({ cases }));

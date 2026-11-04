import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EXTENDED_SAVE_SIZE, PERF_OFF, PROFILE_SIZE, SLOT_BOUGHT_REL, dataView, slotBase } from '../model/layout.js';
import { parseGameData } from '../model/dyno.js';
import { getCarTypeHash, isSlotUsed, slotState } from '../model/slots.js';
import { buildGarage, mergeGarage, GARAGE_MAGIC, GARAGE_SIZE } from '../model/nfsu2-web.js';
import { colorPalettes, gameHash, isVisualColorSlot, parseVisualData, readVisual, VisualCatalog, VISUAL_COUNT, VISUAL_OFF, VISUAL_SLOTS,
  type VisualPart } from '../model/visual.js';

const car = gameHash('TESTCAR');
function part(hash: number, type: number, level = 0, attributes = new Map<number, number[]>()): VisualPart {
  return { hash, type, level, variant: 1, name: `Part ${hash}`, group: car, attributes, color: '' };
}
function fixture() {
  const defaults = Array.from({ length: VISUAL_COUNT * 2 }, (_, i) => i % 2 ? 0 : 0xffffffff);
  const parts = [
    part(11, 1, 2), part(12, 1, 3), part(21, 28, 1),
    part(31, 9, 1, new Map([[gameHash('HOODUNDER'), [32]], [gameHash('CARBONFIBRE'), [1]]])),
    part(32, 25), part(40, 50, 0), { ...part(41, 50), variant: 20 },
    part(50, 6, 1), part(51, 17), part(52, 18), part(53, 19), part(54, 20), part(55, 21), part(56, 22),
    part(60, 60), part(61, 61), part(62, 62), part(63, 63),
    part(70, 65), part(71, 64),
  ];
  const catalog = new VisualCatalog(parts, defaults, new Map(), new Map([[car, 'TESTCAR']]));
  const save = new Uint8Array(EXTENDED_SAVE_SIZE);
  for (let slot = 0; slot < 10; slot++) dataView(save).setUint32(slotBase(slot) + 0x14, car, true);
  return { catalog, save };
}
function put(save: Uint8Array, slot: number, visual: number, hash: number): void {
  dataView(save).setUint32(slotBase(slot) + VISUAL_OFF + visual * 4, hash, true);
}
function changed(before: Uint8Array, after: Uint8Array): number[] {
  return Array.from(before.keys()).filter((i) => before[i] !== after[i]);
}

test('visual slot definitions distinguish layers, 16 colours, dials and derived slots', () => {
  assert.equal(VISUAL_SLOTS.length, 126);
  assert.equal(new Set(VISUAL_SLOTS.map((s) => s.id)).size, 126);
  assert.equal(VISUAL_SLOTS.find((s) => s.id === 32)?.name, 'WING_MIRROR');
  assert.equal(VISUAL_SLOTS.find((s) => s.id === 63)?.name, 'BASE_PAINT');
  assert.equal(VISUAL_SLOTS.find((s) => s.id === 64)?.name, 'VINYL_LAYER0');
  assert.equal(VISUAL_SLOTS.find((s) => s.id === 92)?.name, 'VINYL_COLOUR3_3');
  assert.equal(VISUAL_SLOTS.find((s) => s.id === 166)?.name, 'HUD_CHARACTER_COLOUR');
  for (const id of [0,5,25,30,97,104,158,167,168,169]) assert.ok(!VISUAL_SLOTS.some((s) => s.id === id));
});

test('wheel edits link both axles and preserve every other byte in all ten slots', () => {
  const { catalog, save } = fixture(), before = save.slice();
  for (let slot = 0; slot < 10; slot++) {
    const out = catalog.edit(save, slot, 29, 21), refs = readVisual(out, slot);
    assert.equal(refs[29], 21);
    assert.equal(refs[30], 21);
    assert.deepEqual(changed(save, out), [29,30].map((id) => slotBase(slot) + VISUAL_OFF + id * 4));
  }
  assert.deepEqual(save, before);
  assert.throws(() => readVisual(save.subarray(0, PROFILE_SIZE), 9), /Slot must/);
});

test('visual editing rejects incompatible, unknown, noninteger and derived slots', () => {
  const { catalog, save } = fixture();
  assert.throws(() => catalog.edit(save, 0, 1, 21), /not compatible/);
  assert.throws(() => catalog.edit(save, 0, 1, 0xdeadbeef), /not compatible/);
  for (const id of [25,97,104,170,-1,1.5]) assert.throws(() => catalog.edit(save, 0, id, 11), /not editable/);
  assert.throws(() => catalog.options(car, NaN), /Invalid visual slot/);
  assert.deepEqual(catalog.options(0xdeadbeef, 1), []);
});

test('unknown installed hashes are preserved and do not get replaced by unrelated edits', () => {
  const { catalog, save } = fixture();
  put(save, 0, 64, 0xdeadbeef);
  const out = catalog.edit(save, 0, 163, 71);
  assert.equal(readVisual(out, 0)[64], 0xdeadbeef);
  assert.equal(readVisual(out, 0)[163], 71);
  assert.ok(changed(save, out).every((i) => i >= slotBase(0) + VISUAL_OFF + 163 * 4 &&
    i < slotBase(0) + VISUAL_OFF + 164 * 4));
});

test('paint category filtering applies to choices and writes without losing installed cross-category colours', () => {
  const { save } = fixture();
  const categories = ['GLOSS', 'METAL', 'PEARL', 'HOSE', 'CALIPER', 'MUFFLER', 'RIM', 'VINYL'];
  const colors = categories.map((name, i) => ({
    ...part(100 + i, name === 'VINYL' ? 49 : 48),
    name: `${name}_L1_COLOR01`, color: '#808080',
    attributes: new Map([[0xebb03e66, [gameHash(name)]]]),
  }));
  const missingCategory = { ...part(200, 48), name: 'UNCLASSIFIED' };
  const defaults = Array.from({ length: VISUAL_COUNT * 2 }, (_, i) => i % 2 ? 0 : 0xffffffff);
  const cat = new VisualCatalog([...colors, missingCategory], defaults, new Map(), new Map([[car, 'TESTCAR']]));
  for (const id of [63,69,75,76]) {
    assert.deepEqual(cat.selectableOptions(car, id).map((p) => p.hash), [100,101,102]);
    assert.throws(() => cat.edit(save, 0, id, 103), /different paint category/);
    assert.throws(() => cat.edit(save, 0, id, 200), /different paint category/);
  }
  for (const [id, hash] of [[68,103],[70,104],[71,105],[73,106],[74,106],[77,107],[92,107]]) {
    assert.deepEqual(cat.selectableOptions(car, id).map((p) => p.hash), [hash]);
    assert.equal(readVisual(cat.edit(save, 0, id, hash), 0)[id], hash);
  }
  // Native PAINT_AUDIO uses the generic, unfiltered list.
  assert.equal(cat.selectableOptions(car, 72).length, 8);
  put(save, 0, 63, 103);
  assert.equal(cat.part(car, 63, 103)?.name, 'HOSE_L1_COLOR01');
  assert.equal(readVisual(cat.edit(save, 0, 68, 103), 0)[63], 103);
  assert.equal(readVisual(cat.edit(save, 0, 63, 100), 0)[63], 100);
});

test('swatch palettes use numeric order, retain native family order and merge the unusual hoses L3 names', () => {
  const names = ['GLOSS_L2_COLOR10','GLOSS_L2_COLOR02','GLOSS_L2_COLOR01','PEARL10_PAINT','PEARL2_PAINT',
    'HOSES_L3_COLOR30','HOSES_L3_TEST01','HOSES_L3_COLOR02','WHITE','BLUE'];
  const palettes = colorPalettes(names.map((name, i) => ({ ...part(i + 1, 48), name, color: i ? '#ffffff' : '#000000' })));
  assert.deepEqual(palettes.map((p) => p.name), ['GLOSS_L2_COLOR##','PEARL##_PAINT','HOSES_L3','Colours']);
  assert.deepEqual(palettes[0].swatches.map((p) => p.number), ['01','02','10']);
  assert.deepEqual(palettes[1].swatches.map((p) => p.number), ['02','10']);
  assert.deepEqual(palettes[2].swatches.map((p) => p.number), ['01','02','30']);
  assert.deepEqual(palettes[3].swatches.map((p) => p.name), ['WHITE','BLUE']);
  assert.equal(palettes[0].swatches[2].ink, '#ffffff');
  assert.equal(palettes[0].swatches[0].ink, '#111111');
  for (const id of [63,68,76,77,92,164,166]) assert.equal(isVisualColorSlot(id), true);
  for (const id of [62,64,67,93,163,167]) assert.equal(isVisualColorSlot(id), false);
});

test('window tint cannot change ownership or make a bought car appear empty', () => {
  const { catalog, save } = fixture();
  save[slotBase(0) + SLOT_BOUGHT_REL] = 1;
  put(save, 0, 153, 0xdeadbeef);
  const out = catalog.edit(save, 0, 153, 0);
  assert.equal(isSlotUsed(out, 0), true);
  assert.equal(slotState(out, 0), 'filled');
  save[slotBase(0) + SLOT_BOUGHT_REL] = 0;
  assert.equal(isSlotUsed(save, 0), false, 'a stale tint hash does not make an unowned record used');
});
test('hood and carbon dependencies derive the under-hood part and remove incompatible vinyls only', () => {
  const { catalog, save } = fixture();
  put(save, 0, 64, 41);
  put(save, 0, 65, 40);
  const out = catalog.edit(save, 0, 9, 31), refs = readVisual(out, 0);
  assert.equal(refs[9], 31);
  assert.equal(refs[25], 32);
  assert.equal(refs[64], 0);
  assert.equal(refs[65], 40);
  assert.deepEqual(readVisual(save, 0).slice(64, 66), [41, 40]);
});

test('body changes refresh only the twelve visual-derived performance flags', () => {
  const { catalog, save } = fixture(), base = slotBase(0) + PERF_OFF;
  save.fill(0xa5, base, base + 68);
  const out = catalog.edit(save, 0, 1, 11);
  assert.equal(out[base + 57], 1);
  assert.equal(out.subarray(base + 56, base + 68).reduce((a, b) => a + b), 1);
  assert.deepEqual(out.subarray(base, base + 56), save.subarray(base, base + 56));
  const wide = catalog.edit(out, 0, 6, 50);
  assert.deepEqual(Array.from(wide.subarray(base + 56, base + 68)), [0,0,1,0,0,1,0,0,1,0,0,1]);
  assert.ok(catalog.hidden(readVisual(wide, 0), car, 1));
  assert.throws(() => catalog.edit(wide, 0, 1, 12), /hidden/);
});

test('trunk layout changes reset component slots to stock selections', () => {
  const { catalog, save } = fixture();
  for (let i = 35; i <= 46; i++) put(save, 0, i, 0xdeadbeef);
  const refs = readVisual(catalog.edit(save, 0, 34, 60), 0);
  assert.equal(refs[34], 60);
  assert.deepEqual(refs.slice(35, 47), [61,61,62,62,63,63,61,61,61,61,62,62]);
});

test('catalogue group priority and EXCLUDE_UG1 restrictions follow the native lookup', () => {
  const first = 0xdb7c, second = 0xacc9;
  const defaults = Array(VISUAL_COUNT * 2).fill(0);
  defaults[2] = first; defaults[3] = second;
  const parts = [
    { ...part(1, 1), group: second },
    { ...part(2, 1), group: first },
    { ...part(3, 1, 0, new Map([[gameHash('EXCLUDE_UG1'), [1]]])), group: first },
  ];
  const cat = new VisualCatalog(parts, defaults, new Map(), new Map([[car, 'TESTCAR']]));
  assert.deepEqual(cat.options(car, 1).map((p) => p.hash), [2,1]);
});

test('visual parser rejects malformed and incomplete local databases', () => {
  assert.throws(() => parseVisualData(new Uint8Array(7), []), /Truncated/);
  const chunk = new Uint8Array(12);
  dataView(chunk).setUint32(4, 20, true);
  assert.throws(() => parseVisualData(chunk, []), /exceeds/);
  assert.throws(() => parseVisualData(new Uint8Array(8), []), /Missing or invalid/);
});

const gamePath = process.env.NFSU2_GLOBALB ??
  'C:\\Program Files (x86)\\EA GAMES\\Need for Speed Underground 2\\GLOBAL\\GLOBALB.BUN';
const fixturePath = fileURLToPath(new URL('../../testfile/treav0r', import.meta.url));

test('local catalogue enumerates every car/menu, names all 12167 descriptors and reads RGB colours',
  { skip: !existsSync(gamePath) && 'Local GLOBALB.BUN unavailable' }, () => {
    const bytes = new Uint8Array(readFileSync(gamePath)), game = parseGameData(bytes), cat = parseVisualData(bytes, game.cars);
    assert.equal(game.cars.length, 46);
    assert.equal(cat.parts.length, 12167);
    assert.ok(cat.parts.every((p) => p.name.length > 0));
    const silver = cat.parts.find((p) => p.name === 'GLOSS_L1_COLOR01');
    assert.equal(silver?.color, '#82828e');
    let rows = 0;
    for (const car of game.cars) {
      const save = new Uint8Array(PROFILE_SIZE);
      dataView(save).setUint32(slotBase(0) + 0x14, car.hash, true);
      for (const spec of VISUAL_SLOTS) {
        const options = cat.selectableOptions(car.hash, spec.id);
        assert.ok(options.every((p) => Number.isInteger(p.hash) && p.name.length > 0));
        if (options.length) rows++;
        for (const choice of options.length ? [options[0], options.at(-1)!] : []) {
          const out = cat.edit(save, 0, spec.id, choice.hash);
          assert.equal(readVisual(out, 0)[spec.id], choice.hash, `${car.name}:${spec.name}`);
          assert.ok(changed(save, out).every((i) =>
            i >= slotBase(0) + VISUAL_OFF && i < slotBase(0) + VISUAL_OFF + VISUAL_COUNT * 4 ||
            i >= slotBase(0) + PERF_OFF + 56 && i < slotBase(0) + PERF_OFF + 68));
        }
      }
    }
    assert.ok(rows > 3000, `${rows} car/menu combinations`);
    const bad = bytes.slice();
    dataView(bad).setUint32(0x6e0aa4 + 56, 0xffffffff, true);
    assert.throws(() => parseVisualData(bad, game.cars), /descriptor count/);
    assert.throws(() => parseVisualData(bytes.subarray(0, bytes.length - 1), game.cars), /exceeds|Truncated/);
  });

test('local colour palettes contain only the native paint categories, with all numbered colours exposed',
  { skip: !existsSync(gamePath) && 'Local GLOBALB.BUN unavailable' }, () => {
    const bytes = new Uint8Array(readFileSync(gamePath)), game = parseGameData(bytes), cat = parseVisualData(bytes, game.cars);
    for (const car of game.cars) {
      for (const [slot, count, brands] of [
        [63,150,['GLOSS','METAL','PEARL']], [68,60,['HOSE']], [69,150,['GLOSS','METAL','PEARL']],
        [70,60,['CALIPER']], [71,60,['MUFFLER']], [73,60,['RIM']], [74,60,['RIM']],
        [75,150,['GLOSS','METAL','PEARL']], [76,150,['GLOSS','METAL','PEARL']],
        ...Array.from({ length: 16 }, (_, i) => [77 + i,60,['VINYL']] as const),
      ] as const) {
        const options = cat.selectableOptions(car.hash, slot);
        assert.equal(options.length, count, `${car.name}:${slot}`);
        assert.ok(options.every((p) => brands.some((b) => gameHash(b) === p.attributes.get(0xebb03e66)?.[0])));
        assert.ok(options.every((p) => /^#[0-9a-f]{6}$/i.test(p.color)));
        const palettes = colorPalettes(options);
        assert.equal(palettes.flatMap((p) => p.swatches).length, count);
        for (const palette of palettes) {
          const numbers = palette.swatches.map((p) => Number(p.number));
          assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b));
        }
      }
      assert.equal(cat.selectableOptions(car.hash, 72).length, 270);
      for (const id of [164,165,166]) assert.equal(cat.selectableOptions(car.hash, id).length, 12);
      assert.equal(colorPalettes(cat.selectableOptions(car.hash, 68)).at(-1)?.swatches.length, 30);
    }
  });

test('local career resolves every nonzero installed visual hash and ZIP extra-slot edits round-trip',
  { skip: (!existsSync(gamePath) || !existsSync(fixturePath)) && 'Local game/save unavailable' }, () => {
    const bytes = new Uint8Array(readFileSync(gamePath)), game = parseGameData(bytes), cat = parseVisualData(bytes, game.cars);
    const save = new Uint8Array(readFileSync(fixturePath));
    for (let slot = 0; slot < 5; slot++) {
      const car = getCarTypeHash(save, slot);
      readVisual(save, slot).forEach((hash, id) => {
        if (hash) assert.ok(cat.part(car, id, hash), `${slot}:${id}:${hash.toString(16)}`);
      });
    }
    const extended = new Uint8Array(EXTENDED_SAVE_SIZE);
    extended.set(save);
    const records = Array.from({ length: 10 }, (_, i) => save.subarray(slotBase(i % 5) - 8, slotBase(i % 5) - 8 + 0x7f2));
    for (let slot = 5; slot < 10; slot++) extended.set(records[slot], slotBase(slot) - 8);
    const car = getCarTypeHash(extended, 5), wheel = cat.options(car, 29).at(-1)!;
    const edited = cat.edit(extended, 5, 29, wheel.hash);
    const template = new Uint8Array(GARAGE_SIZE);
    template.set(GARAGE_MAGIC);
    dataView(template).setUint32(4, 1, true);
    const garage = buildGarage(template, edited, save), merged = mergeGarage(save, garage);
    assert.deepEqual(merged, edited);
    assert.deepEqual(edited.subarray(0, PROFILE_SIZE), save);
  });

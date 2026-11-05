import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { EditorController } from '../controller/editor-controller.js';
import type { EditorScope } from '../controller/editor-scope.js';
import { parseGameData } from '../model/dyno.js';
import {
  careerReport, completeCareer, discoverCareerShops, parseCareerDatabase, setCareerStage, stageResultCount,
  EVENT_CAPACITY, EVENT_COUNT_OFF, EVENT_OFF, STAGE_OFF, STAGE_STRIDE, type CareerDatabase,
} from '../model/career.js';
import { CURRENT_STAGE_OFF, dataView, EXTENDED_SAVE_SIZE, PROFILE_SIZE } from '../model/layout.js';
import { recalculateChecksums, verifyChecksums } from '../model/save-file.js';
import { readZip, writeZip, type ZipEntry } from '../model/zip.js';

const car = { index: 0, hash: 100, name: 'Test car', view: new DataView(new ArrayBuffer(0x780)) };
function database(): CareerDatabase {
  return {
    events: new Map([
      [10, { hash: 10, name: 'PREREQUISITE', stage: 2, kind: 3, special: false }],
      [11, { hash: 11, name: 'REGIONAL', stage: 2, kind: 3, special: false }],
    ]),
    shops: [
      { hash: 20, name: 'Eligible', type: 1, stage: 2, discovery: true, gate: 0, requirement: 0 },
      { hash: 21, name: 'Future', type: 2, stage: 5, discovery: true, gate: 0, requirement: 0 },
      { hash: 22, name: 'Prerequisite', type: 4, stage: 2, discovery: true, gate: 1, requirement: 10 },
      { hash: 23, name: 'Race-count gate', type: 5, stage: 2, discovery: true, gate: 3, requirement: 2 },
    ],
    parts: [
      { item: 1, level: 1, type: 1, requirement: 20 },
      { item: 2, level: 2, type: 2, requirement: (2 << 16) | 2 },
      { item: 3, level: 3, type: 3, requirement: (1 << 16) | 1 },
      { item: 4, level: 3, type: 4, requirement: (2 << 16) | 1 },
      { item: 5, level: 1, type: 6, requirement: 0 },
    ],
    cars: [car], carGates: [{ hash: car.hash, events: [10, 11] }],
    stages: Array.from({ length: 6 }, (_, id) => ({ id, finalEvent: id === 2 ? 10 : 0 })),
    photos: [{ hash: 30, stage: 2 }],
  };
}
function save(extended = false): Uint8Array {
  const out = new Uint8Array(extended ? EXTENDED_SAVE_SIZE : PROFILE_SIZE);
  const dv = dataView(out);
  dv.setUint32(CURRENT_STAGE_OFF, 2, true);
  dv.setUint32(0x4a4, 1, true);
  dv.setInt32(0x24 + 0x14, 0, true);
  return out;
}
function append(data: Uint8Array, hash: number, discovery: number, status: number): number {
  const dv = dataView(data), count = dv.getUint32(EVENT_COUNT_OFF, true), off = EVENT_OFF + count * 8;
  dv.setUint32(off, hash, true);
  data[off + 4] = discovery;
  data[off + 6] = status;
  dv.setUint32(EVENT_COUNT_OFF, count + 1, true);
  return off;
}

test('shop discovery changes only eligible discovery entries, never stage or completion history', () => {
  const db = database(), source = save(true);
  const existing = append(source, 20, 0, 5);
  append(source, 10, 1, 1);
  source[existing + 5] = 123;
  source[existing + 7] = 45;
  source.fill(0xa5, PROFILE_SIZE);
  source.fill(0xff, EVENT_OFF + 16, EVENT_OFF + 24);
  const before = source.slice(), report = careerReport(source, db);
  assert.deepEqual(report.shops.filter((s) => s.discoverable).map((s) => s.hash), [20, 22]);
  const out = discoverCareerShops(source, db);
  assert.deepEqual(source, before);
  assert.equal(out[existing + 4], 1);
  assert.deepEqual(out.subarray(existing + 5, existing + 8), source.subarray(existing + 5, existing + 8));
  assert.equal(dataView(out).getUint32(EVENT_COUNT_OFF, true), 3);
  assert.deepEqual([...out.subarray(EVENT_OFF + 20, EVENT_OFF + 24)], [1, 0, 0, 0]);
  for (let i = 0; i < out.length; i++) {
    if (i === existing + 4 || (i >= EVENT_OFF + 16 && i < EVENT_OFF + 24) ||
        (i >= EVENT_COUNT_OFF && i < EVENT_COUNT_OFF + 4)) continue;
    assert.equal(out[i], source[i], `unrelated byte 0x${i.toString(16)}`);
  }
  assert.deepEqual(discoverCareerShops(out, db), out, 'idempotent');
  assert.equal(careerReport(out, db).parts[0].passed, true, 'shop-based part gate opens by discovery alone');
});

test('prerequisite completion requires status exactly 1, not any nonzero byte', () => {
  for (const status of [0, 1, 2, 3, 5, 255]) {
    const data = save();
    append(data, 10, 1, status);
    const report = careerReport(data, database());
    assert.equal(report.shops[2].passed, status === 1);
    assert.equal(report.cars[0].passed, false, 'second regional prerequisite remains incomplete');
  }
  const data = save();
  append(data, 10, 0, 1);
  append(data, 11, 0, 1);
  assert.equal(careerReport(data, database()).cars[0].passed, true);
});

test('result thresholds count correct nonzero dword sets and exact boundary values', () => {
  const data = save(), dv = dataView(data), stage2 = STAGE_OFF + 2 * STAGE_STRIDE;
  dv.setUint32(stage2, 7, true);
  dv.setUint32(stage2 + 0xdc, 0xffffffff, true);
  assert.equal(stageResultCount(data, 2, 'races'), 1, 'outcome counter is not race-set completion');
  let report = careerReport(data, database());
  assert.equal(report.parts[1].passed, false);
  assert.equal(report.shops[3].passed, false);
  dv.setUint32(stage2 + 34 * 4, 99, true);
  dv.setUint32(stage2 + 0x8c, 1, true);
  dv.setUint32(STAGE_OFF + STAGE_STRIDE + 0x9c, 1, true);
  report = careerReport(data, database());
  assert.equal(report.shops[3].passed, true);
  assert.deepEqual(report.parts.slice(1).map((p) => p.passed), [true, true, true, true]);
  assert.throws(() => stageResultCount(data, 8, 'races'), /stage/);
});

test('capacity failure is atomic; a full table can still update existing shop entries', () => {
  const source = save();
  for (let i = 0; i < EVENT_CAPACITY; i++) append(source, 1000 + i, 0, 0);
  const before = source.slice();
  assert.throws(() => discoverCareerShops(source, database()), /Not enough event slots/);
  assert.deepEqual(source, before);
  dataView(source).setUint32(EVENT_OFF, 20, true);
  const out = discoverCareerShops(source, database());
  assert.equal(out[EVENT_OFF + 4], 1);
  assert.equal(dataView(out).getUint32(EVENT_COUNT_OFF, true), EVENT_CAPACITY);
});

test('malformed saves fail explicitly rather than producing a partial edit/report', () => {
  assert.throws(() => careerReport(new Uint8Array(5), database()), /size/);
  const data = save();
  dataView(data).setUint32(CURRENT_STAGE_OFF, 7, true);
  assert.throws(() => discoverCareerShops(data, database()), /stages/);
  dataView(data).setUint32(CURRENT_STAGE_OFF, 2, true);
  dataView(data).setUint32(EVENT_COUNT_OFF, 385, true);
  assert.throws(() => careerReport(data, database()), /384/);
  dataView(data).setUint32(EVENT_COUNT_OFF, 0, true);
  append(data, 20, 0, 0);
  append(data, 20, 0, 1);
  assert.throws(() => careerReport(data, database()), /duplicate/);
  const empty = database();
  empty.events = new Map();
  assert.throws(() => careerReport(save(), empty), /no event definitions/);
});

function chunk(id: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 8), dv = dataView(out);
  dv.setUint32(0, id, true);
  dv.setUint32(4, payload.length, true);
  out.set(payload, 8);
  return out;
}
function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const part of parts) { out.set(part, off); off += part.length; }
  return out;
}
function bun(): Uint8Array {
  const events = new Uint8Array(0x88);
  dataView(events).setUint32(8, 10, true);
  const shops = new Uint8Array(0xa0);
  dataView(shops).setUint32(0x38, 20, true);
  shops[0x40] = 65; shops[0x50] = 1; shops[0x51] = 1; shops[0x9d] = 2;
  const parts = new Uint8Array(0x28);
  dataView(parts).setUint32(0, 1, true);
  const stages = new Uint8Array(6 * 0x50);
  for (let i = 0; i < 6; i++) stages[i * 0x50] = i;
  const tables = [
    chunk(0x34a1d, new Uint8Array([80, 82, 69, 0])), chunk(0x34a11, events),
    chunk(0x34a12, shops), chunk(0x34a1c, parts), chunk(0x34a1f, new Uint8Array(0)),
    chunk(0x34a18, stages), chunk(0x34a16, new Uint8Array(0)),
  ];
  return chunk(0x80034a10, concat(tables));
}

test('career parser keeps the first complete database separate from a secondary/demo container', () => {
  const first = bun(), second = chunk(0x80034a10, chunk(0x34a11, new Uint8Array(3)));
  const db = parseCareerDatabase(concat([first, second]), [car]);
  assert.equal(db.events.get(10)?.name, 'PRE');
  assert.equal(db.shops[0].hash, 20);
  assert.equal(db.parts.length, 3);
  assert.throws(() => parseCareerDatabase(first.subarray(0, first.length - 1), [car]), /exceeds/);
  assert.throws(() => parseCareerDatabase(new Uint8Array(0), [car]), /Missing/);
});

test('discovered shop bytes survive the normal checksum write', () => {
  const data = save();
  data.set([0x32, 0x30, 0x43, 0x4d]);
  const dv = dataView(data);
  dv.setUint32(4, PROFILE_SIZE, true); dv.setUint32(8, 8, true); dv.setUint32(12, PROFILE_SIZE - 0x24, true);
  const out = recalculateChecksums(discoverCareerShops(data, database()));
  assert.deepEqual(verifyChecksums(out), { blockA: true, blockB: true, header: true });
  assert.equal(careerReport(out, database()).shops[0].discovered, true);
});

test('stage editing changes exactly its uint32 and rejects unsupported stages', () => {
  const data = save(true), before = data.slice();
  const flagged = data.slice();
  flagged[STAGE_OFF + 0xfc] = 2;
  assert.equal(careerReport(flagged, database()).completion.stages, 1, 'native stage flag consumers accept nonzero');
  for (const stage of [0, 1, 2, 3, 4, 5, 6]) {
    const out = setCareerStage(data, stage);
    assert.equal(dataView(out).getUint32(CURRENT_STAGE_OFF, true), stage);
    for (let i = 0; i < out.length; i++) {
      if (i < CURRENT_STAGE_OFF || i >= CURRENT_STAGE_OFF + 4) assert.equal(out[i], data[i]);
    }
  }
  for (const stage of [-1, 7, 1.5, NaN, Infinity]) assert.throws(() => setCareerStage(data, stage), /stage/);
  assert.deepEqual(data, before);
});

test('full completion populates native goal hashes and flags without changing money, cars or opaque history', () => {
  const data = save(true), db = database();
  const race = append(data, 10, 0, 3);
  data[race + 5] = 77; data[race + 7] = 88;
  const other = append(data, 12345, 2, 2);
  data.fill(0xa5, PROFILE_SIZE);
  const before = data.slice(), out = completeCareer(data, db), report = careerReport(out, db);
  assert.equal(report.stage, 6);
  assert.equal(report.completion.percent, 100);
  assert.equal(report.completion.complete, true);
  assert.equal(report.completion.photos, 1);
  assert.equal(stageResultCount(out, 2, 'races'), 2);
  assert.equal(dataView(out).getUint32(STAGE_OFF + 2 * STAGE_STRIDE, true), 10);
  assert.equal(out[race + 5], 77); assert.equal(out[race + 7], 88);
  assert.deepEqual(out.subarray(other, other + 8), before.subarray(other, other + 8));
  assert.deepEqual(out.subarray(PROFILE_SIZE), before.subarray(PROFILE_SIZE));
  assert.ok(report.shops.every((s) => s.discovered));
  const allowed = (i: number): boolean =>
    i >= CURRENT_STAGE_OFF && i < EVENT_OFF + EVENT_CAPACITY * 8 ||
    db.stages.some((s) => {
      const rel = i - (STAGE_OFF + s.id * STAGE_STRIDE);
      return rel >= 0 && rel < 0xc4 || rel >= 0xfc && rel < 0x101;
    });
  for (let i = 0; i < out.length; i++) if (out[i] !== before[i]) assert.ok(allowed(i), `Unexpected write at ${i.toString(16)}`);
  assert.deepEqual(completeCareer(out, db), out);
  assert.deepEqual(data, before);
  const full = save();
  for (let i = 0; i < EVENT_CAPACITY; i++) append(full, 1000 + i, 0, 0);
  const fullBefore = full.slice();
  assert.throws(() => completeCareer(full, db), /Not enough event slots/);
  assert.deepEqual(full, fullBefore);
});

test('full completion caps result sets exactly like the native insertion routine', () => {
  const db = database(), data = save();
  db.events = new Map(Array.from({ length: 42 }, (_, i) => [
    100 + i, { hash: 100 + i, name: `RACE${i}`, stage: 2, kind: 3, special: i === 0 },
  ]));
  db.stages = db.stages.map((s) => ({ ...s, finalEvent: 0 }));
  const out = completeCareer(data, db);
  assert.equal(stageResultCount(out, 2, 'races'), 35);
  assert.equal(dataView(out).getUint32(STAGE_OFF + 2 * STAGE_STRIDE, true), 101);
  assert.equal(careerReport(out, db).completion.percent, 100);
});

const GAME_BUN = process.env.NFSU2_GLOBALB ??
  'C:\\Program Files (x86)\\EA GAMES\\Need for Speed Underground 2\\GLOBAL\\GLOBALB.BUN';
const FIXTURE = new URL('../../testfile/treav0r', import.meta.url);
const SKIP_NO_GAME = (!existsSync(GAME_BUN) || !existsSync(FIXTURE)) && 'GLOBALB.BUN or reference save missing';

test('controller discovers real-BUN shops, honors cancel, refreshes reports and downloads valid CRCs', { skip: SKIP_NO_GAME }, async (t) => {
  const bunBytes = new Uint8Array(readFileSync(GAME_BUN));
  const db = parseCareerDatabase(bunBytes, parseGameData(bunBytes).cars);
  const source = new Uint8Array(readFileSync(FIXTURE)), dv = dataView(source);
  for (let i = 0; i < dv.getUint32(EVENT_COUNT_OFF, true); i++) {
    const off = EVENT_OFF + i * 8;
    if (db.shops.some((s) => s.hash === dv.getUint32(off, true))) source[off + 4] = 0;
  }
  let accept = false;
  const confirmations: string[] = [], downloads: Blob[] = [];
  const inputs = new Map<string, Uint8Array>([
    ['GLOBALB.BUN', bunBytes], ['bad.BUN', new Uint8Array(8)], ['reference', source],
  ]);
  function replace(target: object, key: PropertyKey, value: unknown): void {
    const original = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(target, key, original);
      else Reflect.deleteProperty(target, key);
    });
  }
  class Reader {
    result: ArrayBuffer = new ArrayBuffer(0);
    onload: (() => void) | null = null;
    readAsArrayBuffer(file: File): void {
      const bytes = inputs.get(file.name);
      assert.ok(bytes);
      this.result = Uint8Array.from(bytes).buffer;
      this.onload?.();
    }
  }
  replace(globalThis, 'FileReader', Reader);
  replace(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({}) }));
  replace(globalThis, 'confirm', (message: string) => { confirmations.push(message); return accept; });
  replace(globalThis, 'document', {
    createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {} },
  });
  replace(URL, 'createObjectURL', (blob: Blob) => { downloads.push(blob); return 'blob:career-test'; });
  const scope = {
    $apply(callback: () => void) { callback(); }, $evalAsync(callback: () => void) { callback(); },
  } as EditorScope;
  EditorController(scope);
  scope.discoverShops();
  assert.equal(scope.status.type, 'error');
  scope.setCareerStage();
  assert.equal(scope.status.type, 'error');
  scope.completeCareer();
  assert.equal(scope.status.type, 'error');
  scope.loadFile({ name: 'reference' } as File);
  scope.loadGameData({ name: 'GLOBALB.BUN' } as File);
  assert.equal(scope.career.error, '');
  assert.equal(scope.career.report?.stage, 4);
  assert.ok(scope.hasDiscoverableShops());
  const expected = discoverCareerShops(source, db);
  scope.discoverShops();
  assert.ok(scope.hasDiscoverableShops(), 'cancel must preserve report and bytes');
  accept = true;
  scope.discoverShops();
  assert.equal(scope.status.type, 'success');
  assert.equal(scope.hasDiscoverableShops(), false);
  assert.equal(confirmations.length, 2);
  assert.match(confirmations[0], /stage, race completions/);
  assert.deepEqual(scope.career.report, careerReport(expected, db));
  scope.download();
  assert.equal(downloads.length, 1);
  const downloaded = new Uint8Array(await downloads[0].arrayBuffer());
  assert.deepEqual(downloaded, recalculateChecksums(expected));
  assert.deepEqual(verifyChecksums(downloaded), { blockA: true, blockB: true, header: true });
  scope.loadGameData({ name: 'bad.BUN' } as File);
  assert.ok(scope.career.error);
  assert.equal(Boolean(scope.career.report), false);
  assert.equal(scope.hasDiscoverableShops(), false);
  scope.discoverShops();
  assert.equal(scope.status.type, 'error');

  scope.loadGameData({ name: 'GLOBALB.BUN' } as File);
  const second = source.slice();
  dataView(second).setUint32(CURRENT_STAGE_OFF, 1, true);
  function entry(name: string, bytes: Uint8Array): ZipEntry {
    return { name, data: bytes, time: 0, date: 0, utf8: true, versionMadeBy: 20, internalAttributes: 0, externalAttributes: 0 };
  }
  const entries = [
    entry('NFS Underground 2/A/A', recalculateChecksums(source)),
    entry('NFS Underground 2/B/B', recalculateChecksums(second)),
    entry('settings.ini', new Uint8Array([1, 2, 3])),
  ];
  inputs.set('backup.zip', writeZip({ entries, comment: new Uint8Array() }));
  scope.loadFile({ name: 'backup.zip' } as File);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(scope.career.report?.stage, 4);
  scope.discoverShops();
  const firstReport = scope.career.report;
  assert.equal(scope.hasDiscoverableShops(), false);
  scope.selectProfile(1);
  assert.deepEqual(scope.career.report, careerReport(second, db));
  scope.selectProfile(0);
  assert.deepEqual(scope.career.report, firstReport, 'switching profiles must retain the edited report');
  scope.download();
  const zipped = await readZip(new Uint8Array(await downloads[1].arrayBuffer()));
  assert.deepEqual(zipped.entries[0].data, recalculateChecksums(expected));
  assert.deepEqual(zipped.entries[1], entries[1], 'other profile must remain byte-identical');
  assert.deepEqual(zipped.entries[2], entries[2]);

  accept = false;
  scope.career.stage = 3;
  scope.setCareerStage();
  assert.equal(scope.career.report?.stage, 4);
  accept = true;
  scope.setCareerStage();
  const staged = setCareerStage(expected, 3);
  assert.deepEqual(scope.career.report, careerReport(staged, db));
  accept = false;
  scope.completeCareer();
  assert.deepEqual(scope.career.report, careerReport(staged, db));
  accept = true;
  scope.completeCareer();
  const completed = completeCareer(staged, db);
  assert.deepEqual(scope.career.report, careerReport(completed, db));
  assert.equal(scope.career.report?.completion.complete, true);
  assert.equal(scope.career.report?.completion.percent, 100);
  scope.download();
  const completedZip = await readZip(new Uint8Array(await downloads[2].arrayBuffer()));
  assert.deepEqual(completedZip.entries[0].data, recalculateChecksums(completed));
  assert.deepEqual(completedZip.entries[1], entries[1]);
});

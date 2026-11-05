import { CURRENT_STAGE_OFF, dataView, EXTENDED_SAVE_SIZE, PROFILE_SIZE } from './layout.js';
import type { CarRecord } from './dyno.js';

export const EVENT_COUNT_OFF = 0xa179;
export const EVENT_OFF = 0xa17d;
export const EVENT_CAPACITY = 384;
export const STAGE_OFF = 0x9962;
export const STAGE_STRIDE = 0x101;

interface EventDefinition { hash: number; name: string; stage: number; kind: number; special: boolean }
interface StageDefinition { id: number; finalEvent: number }
interface PhotoDefinition { hash: number; stage: number }
interface ShopDefinition {
  hash: number; name: string; type: number; stage: number; discovery: boolean;
  gate: number; requirement: number;
}
interface PartGate { item: number; level: number; type: number; requirement: number }
interface CarGate { hash: number; events: readonly [number, number] }
export interface CareerDatabase {
  events: ReadonlyMap<number, EventDefinition>;
  shops: readonly ShopDefinition[];
  parts: readonly PartGate[];
  cars: readonly CarRecord[];
  carGates: readonly CarGate[];
  stages: readonly StageDefinition[];
  photos: readonly PhotoDefinition[];
}
export interface CareerGateRow { name: string; passed: boolean; reason: string }
export interface CareerShopRow extends CareerGateRow { hash: number; discoverable: boolean; discovered: boolean }
export interface CareerReport {
  stage: number;
  events: number;
  shops: CareerShopRow[];
  cars: CareerGateRow[];
  parts: CareerGateRow[];
  completion: { events: number; totalEvents: number; percent: number; stages: number; photos: number; totalPhotos: number; complete: boolean };
}

const SHOP_NAMES = ['', 'Performance', 'Body', 'Paint', 'Car dealer', 'Specialties'];

/** Select the first career container, as FUN_00512C00's initialized guard does. */
export function parseCareerDatabase(bytes: Uint8Array, cars: readonly CarRecord[]): CareerDatabase {
  const dv = dataView(bytes);
  const containers: Uint8Array[] = [];
  function walk(start: number, end: number): void {
    for (let off = start; off < end;) {
      if (off + 8 > end) throw new Error('Truncated game-data chunk.');
      const id = dv.getUint32(off, true), size = dv.getUint32(off + 4, true), next = off + 8 + size;
      if (next > end) throw new Error('Game-data chunk exceeds its container.');
      if (id === 0x80034a10) containers.push(bytes.subarray(off + 8, next));
      else if (id & 0x80000000) walk(off + 8, next);
      off = next;
    }
  }
  walk(0, bytes.length);
  if (!containers.length) throw new Error('Missing NFSU2 career database in GLOBAL\\GLOBALB.BUN.');
  const chunks = new Map<number, Uint8Array>();
  const raw = containers[0];
  const cv = dataView(raw);
  for (let off = 0; off < raw.length;) {
    if (off + 8 > raw.length) throw new Error('Truncated career-data chunk.');
    const id = cv.getUint32(off, true), size = cv.getUint32(off + 4, true), next = off + 8 + size;
    if (next > raw.length || chunks.has(id)) throw new Error('Invalid or duplicate career-data chunk.');
    chunks.set(id, raw.subarray(off + 8, next));
    off = next;
  }
  function table(id: number, stride: number): Uint8Array {
    const result = chunks.get(id);
    if (!result || result.length % stride) throw new Error(`Missing or invalid career table ${id.toString(16)}.`);
    return result;
  }
  const strings = table(0x34a1d, 1);
  function stringAt(off: number): string {
    const end = strings.indexOf(0, off);
    if (off >= strings.length || end < off) throw new Error('Invalid career string offset.');
    return Array.from(strings.subarray(off, end), (b) => String.fromCharCode(b)).join('');
  }
  const events = new Map<number, EventDefinition>();
  const eventBytes = table(0x34a11, 0x88), ev = dataView(eventBytes);
  if (!eventBytes.length) throw new Error('Career database has no event definitions.');
  for (let off = 0; off < eventBytes.length; off += 0x88) {
    const hash = ev.getUint32(off + 8, true);
    if (!hash || events.has(hash)) throw new Error('Invalid or duplicate career event hash.');
    const stage = eventBytes[off + 0x37], kind = eventBytes[off + 0x34];
    if (stage > 5 || kind > 3) throw new Error('Unsupported career event definition.');
    events.set(hash, { hash, name: stringAt(ev.getUint16(off, true)), stage, kind, special: eventBytes[off + 0xd] === 1 });
  }
  const shops: ShopDefinition[] = [];
  const shopBytes = table(0x34a12, 0xa0), sv = dataView(shopBytes);
  const shopHashes = new Set<number>();
  for (let off = 0; off < shopBytes.length; off += 0xa0) {
    const hash = sv.getUint32(off + 0x38, true), type = shopBytes[off + 0x50];
    if (!hash || shopHashes.has(hash)) throw new Error('Invalid or duplicate shop hash.');
    shopHashes.add(hash);
    if (type < 1 || type > 5) continue; // Exclude the intro home and unique-reward shop.
    const path = shopBytes.subarray(off + 0x40, off + 0x50);
    const end = path.indexOf(0);
    const name = Array.from(end < 0 ? path : path.subarray(0, end), (b) => String.fromCharCode(b)).join('');
    const stage = sv.getInt8(off + 0x9d), gate = shopBytes[off + 0x9c];
    if (stage < 0 || stage > 5 || gate > 4) throw new Error(`Unsupported career shop gate: ${name}.`);
    shops.push({
      hash, name: `${SHOP_NAMES[type]}: ${name.replace(/\.BIN$/i, '')}`, type, stage, gate,
      discovery: shopBytes[off + 0x51] !== 0, requirement: sv.getUint32(off + 0x74, true),
    });
  }
  const parts: PartGate[] = [];
  const partBytes = table(0x34a1c, 0x28), pv = dataView(partBytes);
  for (let off = 0; off < partBytes.length; off += 0x28) {
    const item = pv.getInt32(off, true);
    if (item !== off / 0x28 + 1) throw new Error('Unsupported career part-index sequence.');
    for (let level = 1; level <= 3; level++) {
      const base = off + 4 + (level - 1) * 12;
      const type = pv.getInt8(base + 4);
      if (type < 0 || type > 6) throw new Error('Unsupported career part gate.');
      parts.push({ item, level, type, requirement: pv.getUint32(base + 8, true) });
    }
  }
  const carGates: CarGate[] = [];
  const carBytes = table(0x34a1f, 12), av = dataView(carBytes);
  for (let off = 0; off < carBytes.length; off += 12) {
    carGates.push({ hash: av.getUint32(off, true), events: [av.getUint32(off + 4, true), av.getUint32(off + 8, true)] });
  }
  const stages: StageDefinition[] = [];
  const stageBytes = table(0x34a18, 0x50), tv = dataView(stageBytes);
  if (stageBytes.length !== 6 * 0x50) throw new Error('Career editing requires the six-stage main database.');
  for (let off = 0; off < stageBytes.length; off += 0x50) {
    const id = stageBytes[off];
    if (id !== stages.length) throw new Error('Unsupported career stage sequence.');
    const finalEvent = tv.getUint32(off + 0x28, true);
    if (finalEvent && !events.has(finalEvent)) throw new Error('Unknown final-stage event.');
    stages.push({ id, finalEvent });
  }
  const photos: PhotoDefinition[] = [];
  const photoBytes = table(0x34a16, 0x40), fv = dataView(photoBytes);
  const photoHashes = new Set<number>();
  for (let off = 0; off < photoBytes.length; off += 0x40) {
    const hash = fv.getUint32(off + 0x20, true), stage = photoBytes[off + 0x25];
    if (!hash || photoHashes.has(hash) || events.has(hash) || stage > 5) throw new Error('Invalid career photo goal.');
    photoHashes.add(hash);
    photos.push({ hash, stage });
  }
  return { events, shops, parts, cars, carGates, stages, photos };
}

function savedEvents(data: Uint8Array): Map<number, number> {
  if (data.length !== PROFILE_SIZE && data.length !== EXTENDED_SAVE_SIZE) throw new Error('Unsupported career save size.');
  const dv = dataView(data), count = dv.getUint32(EVENT_COUNT_OFF, true), stage = dv.getUint32(CURRENT_STAGE_OFF, true);
  if (stage > 6) throw new Error('Career access supports stages 0-6 only (6 is post-career).');
  if (count > EVENT_CAPACITY) throw new Error('Career event count exceeds 384.');
  const events = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const off = EVENT_OFF + i * 8, hash = dv.getUint32(off, true);
    if (!hash || events.has(hash)) throw new Error('Invalid or duplicate saved event hash.');
    events.set(hash, off);
  }
  return events;
}

/** Counts nonzero saved results, not the unrelated stage +0xDC outcome counter. */
export function stageResultCount(data: Uint8Array, stage: number, kind: 'races' | 'urls' | 'sponsors'): number {
  if (!Number.isInteger(stage) || stage < 0 || stage > 7) throw new RangeError('Invalid result stage.');
  if (data.length < PROFILE_SIZE) throw new Error('Truncated career save.');
  const [rel, size] = kind === 'races' ? [0, 35] : kind === 'urls' ? [0x8c, 4] : [0x9c, 10];
  const dv = dataView(data), base = STAGE_OFF + stage * STAGE_STRIDE + rel;
  let count = 0;
  for (let i = 0; i < size; i++) if (dv.getUint32(base + i * 4, true) !== 0) count++;
  return count;
}

export function careerReport(data: Uint8Array, db: CareerDatabase): CareerReport {
  if (!db.events.size) throw new Error('Career database has no event definitions.');
  const events = savedEvents(data), dv = dataView(data), stage = dv.getUint32(CURRENT_STAGE_OFF, true);
  const complete = (hash: number): boolean => {
    const off = events.get(hash);
    return off !== undefined && data[off + 6] === 1;
  };
  function eventReason(hash: number): string {
    return `Complete ${db.events.get(hash)?.name ?? `event 0x${hash.toString(16).toUpperCase()}`}`;
  }
  function countGate(which: number, required: number, kind: 'races' | 'urls' | 'sponsors'): string {
    const count = stageResultCount(data, which, kind);
    return count >= required ? '' : `Stage ${which}: ${count}/${required} ${kind} results`;
  }
  function shopReason(shop: ShopDefinition, checkDiscovery: boolean): string {
    if (stage < shop.stage) return `Requires stage ${shop.stage}`;
    if (shop.gate === 1 && !complete(shop.requirement)) return eventReason(shop.requirement);
    if (shop.gate >= 2) {
      const reason = countGate(shop.stage, shop.requirement, shop.gate === 2 ? 'sponsors' : shop.gate === 3 ? 'races' : 'urls');
      if (reason) return reason;
    }
    const off = events.get(shop.hash);
    if (checkDiscovery && shop.discovery && (off === undefined || data[off + 4] !== 1)) return `Discover ${shop.name}`;
    return '';
  }
  const shops = db.shops.map((shop): CareerShopRow => {
    const reason = shopReason(shop, false), off = events.get(shop.hash);
    const discovered = !shop.discovery || (off !== undefined && data[off + 4] === 1);
    return { name: shop.name, hash: shop.hash, passed: !reason, reason, discovered, discoverable: !reason && !discovered };
  });
  const activeStock = dv.getUint32(0x4a4, true);
  if (activeStock > 48) throw new Error('Invalid active stock-car count.');
  const cars: CareerGateRow[] = [];
  for (let i = 0; i < activeStock; i++) {
    const index = dv.getInt32(0x24 + i * 0x18 + 0x14, true);
    const car = db.cars.find((car) => car.index === index);
    if (!car) throw new Error('Saved stock-car index is absent from this BUN.');
    const gate = db.carGates.find((gate) => gate.hash === car.hash);
    const reasons = gate?.events.map((hash) => db.events.has(hash) && !complete(hash) ? eventReason(hash) : '') ?? ['', ''];
    const unique = [...new Set(reasons)];
    const reason = unique.length === 1 ? unique[0] : `Game-region dependent: ${reasons.map((r) => r || 'gate passed').join(' / ')}`;
    cars.push({ name: car.name, passed: reasons.every((r) => !r), reason });
  }
  const parts = db.parts.map((part): CareerGateRow => {
    let reason = '';
    if (part.type === 1) {
      const shop = db.shops.find((s) => s.hash === part.requirement);
      if (!shop) throw new Error(`Unknown shop prerequisite for part ${part.item}.`);
      reason = shopReason(shop, true);
    } else if (part.type >= 2 && part.type <= 4) {
      const which = part.requirement >>> 16, required = part.requirement & 0xffff;
      reason = countGate(which, required, part.type === 2 ? 'races' : part.type === 3 ? 'sponsors' : 'urls');
    }
    return { name: `Item ${part.item}, level ${part.level}`, passed: !reason, reason };
  });
  const completedEvents = [...db.events.keys()].filter(complete).length;
  const completedStages = db.stages.filter((s) => data[STAGE_OFF + s.id * STAGE_STRIDE + 0xfc] !== 0).length;
  const completedPhotos = db.photos.filter((p) => complete(p.hash)).length;
  return { stage, events: events.size, shops, cars, parts, completion: {
    events: completedEvents, totalEvents: db.events.size, percent: completedEvents / db.events.size * 100,
    stages: completedStages, photos: completedPhotos, totalPhotos: db.photos.length,
    complete: completedEvents === db.events.size && completedStages === db.stages.length &&
      completedPhotos === db.photos.length && stage === 6,
  } };
}

function ensureEvent(out: Uint8Array, events: Map<number, number>, hash: number): number {
  const existing = events.get(hash);
  if (existing !== undefined) return existing;
  if (events.size >= EVENT_CAPACITY) throw new Error('Not enough career event slots.');
  const off = EVENT_OFF + events.size * 8;
  // Initialize stale inactive bytes instead of importing bogus completion history.
  out.fill(0, off, off + 8);
  dataView(out).setUint32(off, hash, true);
  events.set(hash, off);
  dataView(out).setUint32(EVENT_COUNT_OFF, events.size, true);
  return off;
}

/** Set only +4 discovery bytes for standard shops whose stage and prerequisites already pass. */
export function discoverCareerShops(data: Uint8Array, db: CareerDatabase): Uint8Array {
  const report = careerReport(data, db), events = savedEvents(data);
  const selected = report.shops.filter((shop) => shop.discoverable);
  const needed = selected.filter((shop) => !events.has(shop.hash)).length;
  if (events.size + needed > EVENT_CAPACITY) throw new Error('Not enough event slots to discover eligible shops.');
  const out = data.slice();
  for (const shop of selected) {
    const off = ensureEvent(out, events, shop.hash);
    out[off + 4] = 1;
  }
  return out;
}

export function setCareerStage(data: Uint8Array, stage: number): Uint8Array {
  savedEvents(data);
  if (!Number.isInteger(stage) || stage < 0 || stage > 6) throw new RangeError('Choose career stage 0-6.');
  const out = data.slice();
  dataView(out).setUint32(CURRENT_STAGE_OFF, stage, true);
  return out;
}

/** Complete real BUN goals; never forge money, reward ownership, SMS or collectible flags. */
export function completeCareer(data: Uint8Array, db: CareerDatabase): Uint8Array {
  const events = savedEvents(data);
  if (!db.events.size || db.stages.length !== 6) throw new Error('Full completion requires the main career database.');
  const hashes = new Set([...db.events.keys(), ...db.photos.map((p) => p.hash), ...db.shops.filter((s) => s.discovery).map((s) => s.hash)]);
  const needed = [...hashes].filter((hash) => !events.has(hash)).length;
  if (events.size + needed > EVENT_CAPACITY) throw new Error('Not enough event slots to complete the career.');
  const out = data.slice(), dv = dataView(out);
  for (const event of db.events.values()) {
    const off = ensureEvent(out, events, event.hash);
    out[off + 4] = 1;
    out[off + 6] = 1;
    const [rel, size] = event.kind === 1 ? [0x8c, 4] : event.kind === 2 ? [0x9c, 10] : [0, 35];
    if (event.kind === 0 || (event.kind === 3 && event.special)) continue;
    const base = STAGE_OFF + event.stage * STAGE_STRIDE + rel;
    // FUN_00513390 fills the first empty entry, avoids duplicates, and caps each set.
    for (let i = 0; i < size; i++) {
      const slot = base + i * 4, value = dv.getUint32(slot, true);
      if (value === event.hash) break;
      if (value === 0) { dv.setUint32(slot, event.hash, true); break; }
    }
  }
  for (const photo of db.photos) {
    const off = ensureEvent(out, events, photo.hash);
    out[off + 4] = 2;
    out[off + 6] = 1;
  }
  for (const stage of db.stages) {
    if (stage.finalEvent) {
      const off = events.get(stage.finalEvent);
      if (off === undefined || out[off + 6] !== 1) throw new Error('Final career goal is missing.');
    }
    const base = STAGE_OFF + stage.id * STAGE_STRIDE;
    out[base + 0xfc] = 1;
    dv.setInt32(base + 0xfd, stage.id, true);
  }
  dv.setUint32(CURRENT_STAGE_OFF, 6, true);
  return discoverCareerShops(out, db);
}

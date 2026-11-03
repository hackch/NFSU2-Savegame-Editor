/**
 * Dyno model of NFSU2: car physics builder, dyno tuning (gears, ECU, turbo) and the drag / top speed
 * simulation, ported from SPEED2.EXE. Car data comes from the user's own `GLOBAL\GLOBALB.BUN`.
 * See technical.md, "Dyno tuning", for the traced functions.
 */
import { dataView, slotBase } from './layout.js';
import { getCarTypeHash } from './slots.js';

/** Slot-relative car type hash; equals the car record's name hash in GLOBALB.BUN. */
export { CAR_TYPE_HASH_REL } from './layout.js';
/** Slot-relative start of the five dyno setups. */
export const TUNING_OFF = 0x354;
/** Bytes per dyno setup. */
export const SETUP_SIZE = 41;
/** Number of dyno setups per car. */
export const SETUP_COUNT = 5;
/** Setup-relative start of the nine ECU curve bytes. */
export const ECU_OFF = 0x17;
/** Setup-relative start of the nine turbo curve bytes. */
export const TURBO_OFF = 0x20;
/** Points on the ECU and turbo curves. */
export const CURVE_POINTS = 9;
/** Byte value that leaves a parameter at its default. */
export const NEUTRAL_BYTE = 100;
/** Highest useful byte value; larger values clamp to the same result. */
export const MAX_TUNE_BYTE = 200;
/** In-game setup names, by setup index (traced from the dyno screen title switch). */
export const SETUP_NAMES = ['Circuit', 'Drag', 'Drift', 'Street X', 'URL'];

const PERF_COUNT = 68;
const UNIQUE_COUNT = 9;
const INSTALLED_REL = 0x310;
const UNIQUE_REL = 0x2e8;

const CHUNK_CARS = 0x34600;
const CHUNK_PACKAGES = 0x34a15;
const CHUNK_TUNING = 0x34a1a;
const CAR_STRIDE = 0x890;
const CAR_HASH_REL = 0xd0;
const CAR_PHYS_REL = 0x110;
const PHYS_SIZE = 0x2b0;
const PKG_STRIDE = 0x17c;
const PKG_SUB_STRIDE = 0x5c;
const TUN_STRIDE = 0x18;

/** 0-60 / 0-100 display factors per car record index (SPEED2.EXE tables, 31 entries). */
const F60 = [1.02, 1.164, 1.056, 1.32, 1.152, 1.068, 1.248, 1.044, 1.224, 1.08, 1.08, 1.056, 1.164, 1.272, 1.296,
  1.14, 1.092, 1.212, 1.14, 1.092, 1.236, 1.284, 1.344, 1.176, 1.212, 0.972, 0.96, 1.008, 0.81, 1.008, 0.984];
const F100 = [1.22, 1.31, 1.22, 1.3, 1.15, 1.18, 1.27, 1.09, 1.26, 1.24, 1.38, 1.15, 1.18, 1.28, 1.27, 1.05, 1.12,
  1.06, 1.17, 1.31, 1.0, 1.28, 1.18, 1.17, 1.26, 1.06, 1.15, 1.11, 1.1, 1.21, 1.0];

const MPH = 2.237;
const DT = 1 / 60;
const QUARTER_MILE_M = 400.5;
const SPEED_STEP = 1.3410819;
const RAD_PER_RPM = 0.10471204;
const GEAR_SPACING = 0.05;
const P_ECU = 23;
const P_TURBO = 24;

/** One car record from GLOBALB.BUN. */
export interface CarRecord {
  index: number;
  name: string;
  hash: number;
  /** Float view of the record from its physics block on (`R` in technical.md). */
  view: DataView;
}

interface PackageSub { item: number; fractions: number[] }
interface Package { category: number; level: number; subs: PackageSub[] }
interface TuningRecord { item: number; level: number; param: number; type: number; f8: number; fC: number }

/** Game data parsed from GLOBALB.BUN. */
export interface GameData {
  cars: CarRecord[];
  packages: Package[];
  tuning: TuningRecord[];
}

/** Runtime physics block (offsets relative to the 0x2B0-byte physics block) and gear count. */
export interface Phys {
  f: Float64Array;
  gearCount: number;
}

/** Dyno results, in game units shown on the dyno screen. */
export interface DynoResult {
  /** 0-60 mph, seconds. */
  t60: number;
  /** 0-100 mph, seconds. */
  t100: number;
  /** Quarter mile, seconds. */
  quarterMile: number;
  /** Quarter mile trap speed, mph. */
  trapSpeed: number;
  /** Top speed, mph. */
  topSpeed: number;
  /** Quarter mile time interpolated between frames; used to rank setups. */
  quarterExact: number;
  /** Peak torque, N·m. */
  peakTorque: number;
  /** Engine speed of the peak torque, rpm. */
  peakTorqueRpm: number;
  /** Peak power, kW. */
  peakPower: number;
  /** Engine speed of the peak power, rpm. */
  peakPowerRpm: number;
}

/** kW to mechanical hp, the factor the dyno screen uses (`0x79BEF0`). */
export const KW_TO_HP = 1.34102209;
/** N·m to lb-ft, the factor the dyno screen uses (`0x79BEFC`). */
export const NM_TO_LBFT = 0.73756212;
/** mph to km/h. */
export const MPH_TO_KMH = 1.609344;

/** Optimization goals for {@link optimizeSetup}. */
export type DynoGoal = 'quarter' | 'accel60' | 'accel' | 'top' | 'power' | 'torque';

/** Car-related data of a save slot that the dyno needs. */
export interface SlotDyno {
  hash: number;
  installed: boolean[];
  uniques: number[];
  setups: Uint8Array[];
}

/**
 * Parses car records, upgrade packages and tuning records from GLOBALB.BUN.
 * @param bytes File contents.
 * @returns The parsed tables.
 * @throws Error when a table is missing.
 */
export function parseGameData(bytes: Uint8Array): GameData {
  const dv = dataView(bytes);
  const chunks = new Map<number, { off: number; size: number }>();
  const walk = (start: number, end: number): void => {
    let o = start;
    while (o + 8 <= end) {
      const id = dv.getUint32(o, true);
      const size = dv.getUint32(o + 4, true);
      if (o + 8 + size > end) break;
      if (!chunks.has(id)) chunks.set(id, { off: o + 8, size });
      if (id & 0x80000000) walk(o + 8, o + 8 + size);
      o += 8 + size;
    }
  };
  walk(0, bytes.length);
  const get = (id: number) => {
    const c = chunks.get(id);
    if (!c) throw new Error('This file is not GLOBAL\\GLOBALB.BUN from NFSU2 (car tables not found).');
    return c;
  };

  const carChunk = get(CHUNK_CARS);
  let carStart = carChunk.off;
  while (carStart < carChunk.off + 16 && bytes[carStart] === 0x11) carStart++;
  const carCount = Math.floor((carChunk.off + carChunk.size - carStart) / CAR_STRIDE);
  const cars: CarRecord[] = [];
  for (let i = 0; i < carCount; i++) {
    const base = carStart + i * CAR_STRIDE;
    let name = '';
    for (let k = 0; k < 0x20 && bytes[base + k]; k++) name += String.fromCharCode(bytes[base + k]);
    cars.push({
      index: i, name, hash: dv.getUint32(base + CAR_HASH_REL, true),
      view: new DataView(bytes.buffer, bytes.byteOffset + base + CAR_PHYS_REL, CAR_STRIDE - CAR_PHYS_REL),
    });
  }

  const pkgChunk = get(CHUNK_PACKAGES);
  const packages: Package[] = [];
  for (let k = 0; k < Math.floor(pkgChunk.size / PKG_STRIDE); k++) {
    const o = pkgChunk.off + k * PKG_STRIDE;
    const n = Math.min(dv.getUint32(o + 8, true), 4);
    const subs: PackageSub[] = [];
    for (let s = 0; s < n; s++) {
      const so = o + 0xc + s * PKG_SUB_STRIDE;
      subs.push({ item: dv.getUint32(so, true), fractions: [0, 1, 2, 3].map((a) => dv.getFloat32(so + 0x30 + a * 4, true)) });
    }
    packages.push({ category: dv.getUint32(o, true), level: dv.getUint32(o + 4, true), subs });
  }

  const tunChunk = get(CHUNK_TUNING);
  const tuning: TuningRecord[] = [];
  for (let k = 0; k < Math.floor(tunChunk.size / TUN_STRIDE); k++) {
    const o = tunChunk.off + k * TUN_STRIDE;
    tuning.push({
      item: dv.getUint32(o, true), level: bytes[o + 4], param: bytes[o + 5], type: bytes[o + 6],
      f8: dv.getFloat32(o + 8, true), fC: dv.getFloat32(o + 12, true),
    });
  }
  if (!cars.length || !packages.length || !tuning.length) {
    throw new Error('This file is not GLOBAL\\GLOBALB.BUN from NFSU2 (car tables are empty).');
  }
  return { cars, packages, tuning };
}

/**
 * Reads the dyno-relevant data of a car slot.
 * @param save Save bytes.
 * @param slot Slot index.
 * @returns Car hash, installed flags, unique values and the five setups (copies).
 */
export function readSlotDyno(save: Uint8Array, slot: number): SlotDyno {
  const base = slotBase(slot);
  const dv = dataView(save);
  return {
    hash: getCarTypeHash(save, slot),
    installed: Array.from(save.subarray(base + INSTALLED_REL, base + INSTALLED_REL + PERF_COUNT), (b) => b !== 0),
    uniques: Array.from({ length: UNIQUE_COUNT }, (_, i) => dv.getUint32(base + UNIQUE_REL + i * 4, true)),
    setups: Array.from({ length: SETUP_COUNT }, (_, k) => save.slice(base + TUNING_OFF + k * SETUP_SIZE, base + TUNING_OFF + (k + 1) * SETUP_SIZE)),
  };
}

/**
 * Absolute offset of a dyno setup.
 * @param slot Slot index.
 * @param setup Setup index, 0 to {@link SETUP_COUNT} - 1.
 * @returns Offset of the setup's first byte.
 */
export function setupOffset(slot: number, setup: number): number {
  if (!Number.isInteger(setup) || setup < 0 || setup >= SETUP_COUNT) throw new RangeError(`Setup must be 0 to ${SETUP_COUNT - 1}.`);
  return slotBase(slot) + TUNING_OFF + setup * SETUP_SIZE;
}

/**
 * Writes the ECU and turbo curve bytes of one setup. All other bytes stay unchanged.
 * @param save Save bytes (not modified).
 * @param slot Slot index.
 * @param setup Setup index.
 * @param bytes Full 41-byte setup; only bytes 0x17 to 0x28 are written.
 * @returns A changed copy.
 */
export function setSetupCurves(save: Uint8Array, slot: number, setup: number, bytes: Uint8Array): Uint8Array {
  return setSetupTuning(save, slot, setup, bytes);
}

/** Writes one setup's curves and, when requested, final-drive/gear bytes. */
export function setSetupTuning(save: Uint8Array, slot: number, setup: number, bytes: Uint8Array, gearing = false): Uint8Array {
  if (bytes.length !== SETUP_SIZE) throw new RangeError(`A setup has ${SETUP_SIZE} bytes.`);
  const out = save.slice();
  const off = setupOffset(slot, setup);
  out.set(bytes.subarray(ECU_OFF, SETUP_SIZE), off + ECU_OFF);
  if (gearing) out.set(bytes.subarray(9, 16), off + 9);
  return out;
}

/**
 * Finds the BUN car record of a save slot.
 * @param game Parsed game data.
 * @param hash Car type hash from the slot.
 * @returns The record, or null for an unknown car.
 */
export function findCar(game: GameData, hash: number): CarRecord | null {
  return game.cars.find((c) => c.hash === hash) ?? null;
}

const R = (car: CarRecord, off: number): number => car.view.getFloat32(off, true);
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
const byteT = (b: number): number => clamp((b - 100) * 0.01, -1, 1);

function clonePhys(p: Phys): Phys {
  return { f: p.f.slice(), gearCount: p.gearCount };
}

const g = (p: Phys, off: number): number => p.f[off >> 2];
const s = (p: Phys, off: number, v: number): void => { p.f[off >> 2] = v; };

function interp(table: ArrayLike<number>, x0: number, invDx: number, x: number): number {
  const t = (x - x0) * invDx;
  if (t < 0) return table[0];
  const i = Math.floor(t);
  if (i >= table.length - 1) return table[table.length - 1];
  const fr = t - i;
  return fr * table[i + 1] + (1 - fr) * table[i];
}

/** Car with its installed parts: builds physics, applies setups and simulates the dyno. */
export class DynoModel {
  readonly base: Phys;
  private readonly tuneRecords = new Map<number, TuningRecord>();
  private defs = new Map<number, number>();
  private curveDefs = new Map<number, number[]>();
  private curvePeak = new Map<number, number>();

  /**
   * @param game Parsed game data.
   * @param car Car record.
   * @param installed 68 installed part flags.
   * @param uniques Nine unique-performance values (WT, TR, NO, EN, TU, SU, BR, EC, TI).
   */
  constructor(readonly game: GameData, readonly car: CarRecord, readonly installed: boolean[], readonly uniques: number[]) {
    for (const t of game.tuning) {
      if (!this.installed[t.item]) continue;
      const best = this.tuneRecords.get(t.param);
      if (!best || best.level < t.level) this.tuneRecords.set(t.param, t);
    }
    this.base = this.build();
  }

  /** True when the installed parts unlock ECU curve tuning. */
  get ecuTunable(): boolean { return this.tuneRecords.has(P_ECU); }
  /** True when the installed parts unlock turbo curve tuning. */
  get turboTunable(): boolean { return this.tuneRecords.has(P_TURBO); }

  /** Final drive and forward gears unlocked by the installed transmission. */
  get gearingParameters(): number[] {
    return Array.from({ length: 7 }, (_, i) => i + 9).filter((param) => this.active(this.base, param));
  }

  private fraction(cat: number, n: number): { f: number; out: number[] } {
    let out = new Array<number>(n).fill(0);
    for (const pkg of this.game.packages) {
      if (pkg.category !== cat || pkg.level < 1 || pkg.level > 3) continue;
      for (const sub of pkg.subs) {
        if (!this.installed[sub.item]) continue;
        for (let a = 0; a < n; a++) if (sub.fractions[a] !== -1) out[a] += sub.fractions[a];
      }
    }
    let avg = out.reduce((x, y) => x + y, 0) / n;
    if (avg < 0 || avg > 1) {
      out = out.map((v) => clamp(v, 0, 1));
      avg = out.reduce((x, y) => x + y, 0) / n;
    }
    return { f: clamp(avg, 0, 1), out };
  }

  private build(): Phys {
    const c = this.car;
    const p: Phys = { f: new Float64Array(PHYS_SIZE / 4), gearCount: c.view.getInt32(0x1c8, true) };
    for (let o = 0; o < PHYS_SIZE; o += 4) s(p, o, R(c, o));

    let { f, out } = this.fraction(0, 1);
    if (f) {
      s(p, 0, g(p, 0) + R(c, 0x344) * f);
      s(p, 0x160, g(p, 0x160) + (R(c, 0x348) - g(p, 0x160)) * f);
      s(p, 0x110, g(p, 0x110) * ((R(c, 0x340) - 1) * f + 1));
    }
    ({ f, out } = this.fraction(1, 3));
    if (f) {
      const lvl = Math.trunc(out[0] * 3 + 0.5);
      if (lvl >= 1 && lvl <= 3) {
        const gs = 0x310 + lvl * 0x40;
        s(p, 0x1b8, R(c, gs + 8)); s(p, 0x1bc, R(c, gs + 0xc)); s(p, 0x1c0, R(c, gs + 0x10));
        s(p, 0x1b0, R(c, gs)); s(p, 0x1b4, R(c, gs + 4));
        for (let k = 0; k < 8; k++) s(p, 0x1d0 + 4 * k, R(c, gs + 0x20 + 4 * k));
        let cnt = 0;
        for (let k = 2; k < 8 && R(c, gs + 0x20 + 4 * k) !== 0; k++) cnt++;
        p.gearCount = cnt;
      }
      s(p, 0x1cc, g(p, 0x1cc) + (R(c, 0x3ec) - g(p, 0x1cc)) * out[0]);
      s(p, 0x1c4, g(p, 0x1c4) + (R(c, 0x3e4) - g(p, 0x1c4)) * out[0]);
      s(p, 0x1fc, g(p, 0x1fc) + R(c, 0x41c) * out[1]);
    }
    ({ f } = this.fraction(3, 1));
    if (f) {
      for (let i = 0; i < 9; i++) s(p, 0x200 + 4 * i, g(p, 0x200 + 4 * i) + R(c, 0x420 + 4 * i) * f);
      for (let i = 0; i < 3; i++) s(p, 0x248 + 4 * i, g(p, 0x248 + 4 * i) + R(c, 0x444 + 4 * i) * f);
    }
    ({ f } = this.fraction(4, 1));
    for (let i = 0; i < 9; i++) {
      const t = (R(c, 0x510 + 4 * i) - g(p, 0x224 + 4 * i)) * f + g(p, 0x224 + 4 * i);
      s(p, 0x224 + 4 * i, t);
      s(p, 0x200 + 4 * i, g(p, 0x200 + 4 * i) + t);
    }
    ({ f } = this.fraction(7, 1));
    if (this.installed[45] || this.installed[46] || this.installed[51]) s(p, 0x290, 0);
    if (f) {
      const lvl = Math.trunc(f * 3 + 0.5);
      if (lvl >= 1 && lvl <= 3) {
        const e = 0x410 + lvl * 0x40;
        s(p, 0x1f0, g(p, 0x1f0) + R(c, e));
        s(p, 0x1f4, g(p, 0x1f4) + R(c, e + 4));
        s(p, 0x1f8, g(p, 0x1f8) + R(c, e + 8));
      }
      for (let i = 0; i < 9; i++) s(p, 0x200 + 4 * i, g(p, 0x200 + 4 * i) + R(c, 0x4e0 + 4 * i) * f);
    }
    // The unique transmission sets the drive bias, and its removal never restores it.
    if (this.uniques[1]) s(p, 0x1c0, R(c, 0x2b4));
    return p;
  }

  private addUniques(p: Phys): void {
    const c = this.car, u = this.uniques;
    if (u[0]) s(p, 0x110, g(p, 0x110) * (1 - R(c, 0x2b0)));
    for (let i = 0; i < 9; i++) {
      let d = 0;
      if (u[3]) d += R(c, 0x2d0 + 4 * i);
      if (u[7]) d += R(c, 0x2f4 + 4 * i);
      if (u[4]) {
        d += R(c, 0x318 + 4 * i);
        s(p, 0x224 + 4 * i, g(p, 0x224 + 4 * i) + R(c, 0x318 + 4 * i));
      }
      s(p, 0x200 + 4 * i, g(p, 0x200 + 4 * i) + d);
    }
  }

  private active(p: Phys, param: number): boolean {
    if (!this.tuneRecords.has(param)) return false;
    return param >= 10 && param <= 15 ? param - 8 < p.gearCount + 2 : true;
  }

  private static ratioAt(p: Phys, speed: number): number {
    const bias = g(p, 0x1c0);
    const r = bias < 0.2 ? g(p, 0x50) : bias > 0.8 ? g(p, 0x80) : g(p, 0x80) * bias + (1 - bias) * g(p, 0x50);
    return r / speed * (g(p, 0x1f4) * RAD_PER_RPM / g(p, 0x1b8));
  }

  private absRange(p: Phys, param: number): [number, number] {
    const c = this.car;
    const rec = this.tuneRecords.get(param);
    let lo: number, hi: number;
    if (param === 9) {
      lo = Math.min(R(c, 0x1b8), R(c, 0x3d8)); hi = Math.max(R(c, 0x1b8), R(c, 0x3d8));
    } else if (param >= 10 && param <= 15) {
      return [DynoModel.ratioAt(p, 111.75682), DynoModel.ratioAt(p, 1.1175681)];
    } else {
      const vals: number[] = [];
      for (let j = 0; j < 9; j++) {
        if (param === P_ECU) {
          const a = R(c, 0x200 + 4 * j);
          vals.push(a, a + R(c, 0x420 + 4 * j) + R(c, 0x4e0 + 4 * j));
        } else {
          vals.push(R(c, 0x224 + 4 * j), R(c, 0x510 + 4 * j));
        }
      }
      lo = Math.min(...vals); hi = Math.max(...vals);
    }
    if (rec) {
      if (rec.type === 2 || rec.type === 3) [lo, hi] = [(hi - lo) * rec.f8 + lo, (hi - lo) * rec.fC + hi];
      else if (rec.type === 0 || rec.type === 1) [lo, hi] = [lo + rec.f8, hi + rec.fC];
      else if (rec.type === 4) [lo, hi] = [Math.min(lo, rec.f8), Math.max(hi, rec.fC)];
    }
    if (param === P_ECU || param === P_TURBO) [lo, hi] = [Math.max(lo, 0), Math.max(hi, 0)];
    return [lo, hi];
  }

  private caps(p: Phys, param: number, i: number, lo: number, hi: number): [number, number] {
    const defs = this.curveDefs.get(param) as number[];
    hi = Math.min(hi, Math.max(0, ...defs));
    const idle = g(p, 0x1f0), red = g(p, 0x1f8);
    let peak = this.curvePeak.get(param);
    if (peak === undefined) {
      peak = 0;
      const inv = 8 / (red - idle);
      for (let rpm = idle; rpm < red; rpm += 50) {
        const pw = interp(defs, idle, inv, rpm) * 1000 * rpm * 1.0471204e-4;
        if (peak < pw) peak = pw;
      }
      this.curvePeak.set(param, peak);
    }
    const rpmI = (red - idle) * i * 0.125 + idle;
    const pw = hi * 1000 * rpmI * 1.0471204e-4;
    if (peak < pw) hi = Math.max((peak - pw) / (rpmI * RAD_PER_RPM) + hi, 0);
    return [Math.max(lo, 0), Math.max(hi, 0)];
  }

  private range(p: Phys, param: number, i = 0): [number, number] {
    const rec = this.tuneRecords.get(param) as TuningRecord;
    let [lo, hi] = this.absRange(p, param);
    const curve = param === P_ECU || param === P_TURBO;
    const d = curve ? (this.curveDefs.get(param) as number[])[i] : this.defs.get(param) ?? 0;
    if (curve) [lo, hi] = this.caps(p, param, i, lo, hi);
    let mn: number, mx: number;
    if (rec.type === 0) {
      if (param === 3 || param === 7 || param === 9) { mn = Math.max(lo, d - rec.fC); mx = hi; }
      else { mn = lo; mx = Math.min(hi, d + rec.fC); }
    } else if (rec.type === 1) {
      mn = Math.max(lo, d + rec.f8); mx = Math.min(hi, d + rec.fC);
    } else if (rec.type === 4) {
      mn = rec.f8; mx = rec.fC;
    } else {
      throw new Error(`Unsupported tuning record type ${rec.type}.`);
    }
    if (mn === mx) mx += 0.01;
    return [mn, mx];
  }

  private setGear(p: Phys, value: number, param: number): void {
    const arr: number[] = [];
    for (let k = 10; k <= 15; k++) arr[k] = g(p, 0x1b0 + k * 4);
    const ed = (v: number, q: number): number => {
      const [mn, mx] = this.range(p, q);
      const c = clamp(v, mn, mx);
      const d = v - arr[q];
      if (d === 0) return 0;
      const dir = d > 0 && q >= 11 ? -1 : d < 0 && q < 15 ? 1 : 0;
      let exc = v - c;
      if (dir) {
        const n = q + dir;
        const cur = arr[n];
        let next = cur;
        if (dir > 0 && cur > c - GEAR_SPACING) next = c - GEAR_SPACING;
        else if (dir < 0 && cur < c + GEAR_SPACING) next = c + GEAR_SPACING;
        if (next !== cur) exc += ed(next, n);
      }
      arr[q] = v - exc;
      return exc;
    };
    ed(value, param);
    for (let k = 10; k <= 15; k++) {
      if (k - 8 >= p.gearCount + 2) arr[k] = 0;
      s(p, 0x1b0 + k * 4, arr[k]);
    }
  }

  /**
   * Applies a dyno setup like the game's tuning load.
   * @param setup 41 setup bytes.
   * @returns Final physics with uniques.
   */
  tuned(setup: ArrayLike<number>): Phys {
    const p = clonePhys(this.base);
    const gearBytes = Uint8Array.from(setup);
    this.defs = new Map();
    this.curveDefs = new Map();
    this.curvePeak = new Map();
    for (let prm = 9; prm <= 15; prm++) {
      if (this.active(p, prm)) this.defs.set(prm, prm === 9 ? g(p, 0x1b8) : g(p, 0x1b0 + prm * 4));
    }
    for (let prm = 9; prm <= 15; prm++) {
      const def = this.defs.get(prm);
      if (def === undefined) continue;
      const [lo, hi] = this.range(p, prm);
      const v = (hi - lo) * byteT(setup[prm]) + def;
      if (prm === 9) {
        const cv = clamp(v, lo, hi);
        s(p, 0x1b8, cv); s(p, 0x1bc, cv);
      } else {
        this.setGear(p, v, prm);
      }
    }
    for (let prm = 10; prm <= 15; prm++) {
      const def = this.defs.get(prm);
      if (def === undefined) continue;
      const [lo, hi] = this.range(p, prm);
      const value = clamp((hi - lo) * byteT(gearBytes[prm]) + def, lo, hi);
      this.setGear(p, value, prm);
      // The load's second pass re-encodes every active gear before reading the next byte.
      for (let gear = 10; gear <= 15; gear++) {
        const gearDef = this.defs.get(gear);
        if (gearDef === undefined) continue;
        const [min, max] = this.range(p, gear);
        const ratio = clamp(g(p, 0x1b0 + gear * 4), min, max);
        gearBytes[gear] = clamp(Math.floor(100.5 + 100 * (ratio - gearDef) / (max - min)), 0, MAX_TUNE_BYTE);
      }
    }
    const sum = () => { let t = 0; for (let i = 0; i < 9; i++) t += g(p, 0x200 + 4 * i); return t; };
    const s0 = sum();
    for (const [prm, off] of [[P_ECU, ECU_OFF], [P_TURBO, TURBO_OFF]] as const) {
      if (!this.active(p, prm)) continue;
      this.curveDefs.set(prm, Array.from({ length: 9 }, (_, i) =>
        prm === P_ECU ? g(p, 0x200 + 4 * i) - g(p, 0x224 + 4 * i) : g(p, 0x224 + 4 * i)));
      const defs = this.curveDefs.get(prm) as number[];
      for (let i = 0; i < 9; i++) {
        const [lo, hi] = this.range(p, prm, i);
        const v = clamp((hi - lo) * byteT(setup[off + i]) + defs[i], lo, hi);
        if (prm === P_ECU) {
          s(p, 0x200 + 4 * i, v + g(p, 0x224 + 4 * i));
        } else {
          s(p, 0x200 + 4 * i, g(p, 0x200 + 4 * i) + v - g(p, 0x224 + 4 * i));
          s(p, 0x224 + 4 * i, v);
        }
      }
    }
    const s1 = sum();
    if (!(Math.abs(s0 - s1) < 0.001)) {
      const d = (s0 - s1) / 9;
      for (let i = 0; i < 9; i++) s(p, 0x200 + 4 * i, g(p, 0x200 + 4 * i) + d);
    }
    this.addUniques(p);
    return p;
  }

  /**
   * Runs the dyno on a setup.
   * @param setup 41 setup bytes.
   * @returns Simulated times and speeds.
   */
  evaluate(setup: ArrayLike<number>): DynoResult {
    const p = this.tuned(setup);
    return { ...dragSim(p, this.car.index), topSpeed: topSpeed(p) * MPH, ...peaks(p) };
  }
}

/**
 * Peak torque and power, sampled every 50 rpm from idle up to the redline like the game's
 * peak power helper (`FUN_005ac980`). The torque table is in kN·m, so power comes out in kW.
 */
function peaks(p: Phys): Pick<DynoResult, 'peakTorque' | 'peakTorqueRpm' | 'peakPower' | 'peakPowerRpm'> {
  const { tab, idle, inv } = torqueTable(p);
  const red = g(p, 0x1f8);
  let peakTorque = 0, peakTorqueRpm = idle, peakPower = 0, peakPowerRpm = idle;
  for (let rpm = idle; rpm < red; rpm += 50) {
    const nm = interp(tab, idle, inv, rpm) * 1000;
    const kw = nm * rpm * 1.0471204e-4;
    if (nm > peakTorque) { peakTorque = nm; peakTorqueRpm = rpm; }
    if (kw > peakPower) { peakPower = kw; peakPowerRpm = rpm; }
  }
  return { peakTorque, peakTorqueRpm, peakPower, peakPowerRpm };
}

function drive(p: Phys): { fd: number; invR: number } {
  const bias = g(p, 0x1c0);
  return {
    fd: bias * g(p, 0x1bc) + (1 - bias) * g(p, 0x1b8),
    invR: 1 / ((1 - bias) * g(p, 0x20) + bias * g(p, 0x80)),
  };
}

function shiftPoints(p: Phys): number[] {
  const n = p.gearCount;
  const sh: number[] = [];
  sh[1] = (g(p, 0x1f4) - g(p, 0x1f0)) * g(p, 0x1b0) + g(p, 0x1f0);
  for (let k = 2; k <= n; k++) sh[k] = g(p, 0x1f4) - 100;
  sh[n + 1] = g(p, 0x1f8) + 500;
  return sh;
}

function torqueTable(p: Phys): { tab: number[]; idle: number; inv: number } {
  const idle = g(p, 0x1f0);
  return { tab: Array.from({ length: 9 }, (_, i) => g(p, 0x200 + 4 * i)), idle, inv: 8 / (g(p, 0x1f8) - idle) };
}

function dragSim(p: Phys, carIndex: number): Pick<DynoResult, 't60' | 't100' | 'quarterMile' | 'trapSpeed' | 'quarterExact'> {
  const { tab, idle, inv } = torqueTable(p);
  const { fd, invR } = drive(p);
  const sh = shiftPoints(p);
  const mass = g(p, 0x110), k = g(p, 0x260);
  const gears = Array.from({ length: p.gearCount }, (_, i) => g(p, 0x1d8 + 4 * i));
  let gear = 0, v = 0, x = 0, t = 0, c = 1, phase = 1, just = false;
  let t60 = Infinity, t100 = Infinity, qm = Infinity, trap = 0, qmExact = Infinity;
  for (let step = 0; step < 60 * 120; step++) {
    const gr = gears[gear] ?? 0;
    const rpm = invR * v * gr * fd * 9.5493;
    let a: number;
    if (just || !((sh[gear + 2] ?? Infinity) - 100 < rpm)) {
      just = false;
      a = interp(tab, idle, inv, rpm) * gr * fd * invR / mass;
    } else {
      just = true;
      c += DT * (phase ? -3 : 1.5);
      if (c >= 0) {
        just = c < 1;
        if (!just) { gear++; c = 1; phase = 1; }
      } else {
        c = 0; phase = 0;
      }
      a = 0;
    }
    t += DT;
    const dv = (a - v * k * v / mass) * DT;
    x += (0.5 * dv + v) * DT;
    v += dv;
    if (t60 === Infinity && v * MPH >= 60) t60 = t * (F60[carIndex] ?? 0);
    if (t100 === Infinity && v * MPH >= 100) t100 = t * (F100[carIndex] ?? 0);
    if (qm === Infinity && x >= QUARTER_MILE_M) {
      qm = t; trap = v * MPH;
      qmExact = t - (x - QUARTER_MILE_M) / Math.max(v, 1e-6);
    }
    if (t60 !== Infinity && t100 !== Infinity && qm !== Infinity) break;
  }
  return { t60, t100, quarterMile: qm, trapSpeed: trap, quarterExact: qmExact };
}

function topSpeed(p: Phys): number {
  const { tab, idle, inv } = torqueTable(p);
  const { fd, invR } = drive(p);
  const sh = shiftPoints(p);
  const mass = g(p, 0x110), k = g(p, 0x260);
  const gears = Array.from({ length: p.gearCount }, (_, i) => g(p, 0x1d8 + 4 * i));
  const forces: number[] = [];
  let v = 0, gi = 2;
  while (forces.length < 92 && gears.length) {
    let gr = gears[gi - 2];
    const rpm = invR * v * gr * fd * 9.5493;
    if (sh[gi] <= rpm) {
      gi++;
      if (p.gearCount + 2 <= gi) break;
      gr = gears[gi - 2];
    }
    forces.push(interp(tab, idle, inv, rpm) * gr * fd * invR / mass);
    v += SPEED_STEP;
  }
  if (!forces.length) return 0;
  const vmax = v;
  let sp = 0;
  while (sp < vmax && sp * k * sp / mass <= interp(forces, 0, 1 / SPEED_STEP, sp)) sp += SPEED_STEP;
  const limit = g(p, 0x290);
  return limit > 0 && limit * 0.44703 < sp ? limit * 0.44703 : sp;
}

function score(r: DynoResult, goal: DynoGoal): number {
  switch (goal) {
    case 'accel60': return r.t60;
    case 'accel': return r.t100 * 1000 + r.quarterExact;
    case 'top': return -r.topSpeed * 1000 + r.quarterExact;
    case 'power': return -r.peakPower;
    case 'torque': return -r.peakTorque;
    default: return r.quarterExact * 1000 + r.t100 - r.topSpeed * 1e-3;
  }
}

/**
 * Searches the ECU and turbo curve bytes that give the best dyno result for a goal.
 * Optionally includes unlocked gearing for time/speed goals; peak output is independent of gearing.
 * @param model Dyno model of the car.
 * @param setup Current 41 setup bytes.
 * @param goal What to optimize.
 * @param gearing Whether to include final drive and unlocked forward gears.
 * @returns Optimized setup bytes and the results before and after.
 */
export function optimizeSetup(model: DynoModel, setup: ArrayLike<number>, goal: DynoGoal = 'quarter', gearing = false):
  { setup: Uint8Array; before: DynoResult; after: DynoResult } {
  const indices: number[] = [];
  if (gearing && goal !== 'power' && goal !== 'torque') indices.push(...model.gearingParameters);
  if (model.ecuTunable) for (let i = 0; i < CURVE_POINTS; i++) indices.push(ECU_OFF + i);
  if (model.turboTunable) for (let i = 0; i < CURVE_POINTS; i++) indices.push(TURBO_OFF + i);
  const start = Uint8Array.from(setup);
  const before = model.evaluate(start);
  if (!indices.length) return { setup: start, before, after: before };

  const evalScore = (bytes: Uint8Array) => score(model.evaluate(bytes), goal);
  const descend = (initial: Uint8Array): { bytes: Uint8Array; value: number } => {
    const cur = initial.slice();
    let best = evalScore(cur);
    for (let pass = 0; pass < 8; pass++) {
      let improved = false;
      for (const idx of indices) {
        const orig = cur[idx];
        let bestByte = orig;
        const tryByte = (b: number) => {
          if (b < 0 || b > MAX_TUNE_BYTE || b === cur[idx]) return;
          const keep = cur[idx];
          cur[idx] = b;
          const v = evalScore(cur);
          if (v < best - 1e-9) { best = v; bestByte = b; }
          cur[idx] = keep;
        };
        for (let b = 0; b <= MAX_TUNE_BYTE; b += 10) tryByte(b);
        const center = bestByte;
        for (let b = center - 9; b <= center + 9; b++) tryByte(b);
        cur[idx] = bestByte;
        if (bestByte !== orig) improved = true;
      }
      if (!improved) break;
    }
    return { bytes: cur, value: best };
  };

  const seeds: Uint8Array[] = [start.slice()];
  for (const fill of [NEUTRAL_BYTE, 0, MAX_TUNE_BYTE]) {
    const seed = start.slice();
    for (const idx of indices) seed[idx] = fill;
    seeds.push(seed);
  }
  let best: { bytes: Uint8Array; value: number } = { bytes: start, value: score(before, goal) };
  for (const seed of seeds) {
    const r = descend(seed);
    if (r.value < best.value - 1e-9) best = r;
  }
  return { setup: best.bytes, before, after: model.evaluate(best.bytes) };
}

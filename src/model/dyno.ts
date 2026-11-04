/**
 * Dyno model of NFSU2: car physics builder, scalar/gear/curve tuning and the drag / top speed
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
/**
 * FUN_005b2c00 redistribution: weights at 0x7FC674 for neighbours ±1, ±2, ±3, ±4 (the ninth float is the integer 3,
 * a denormal); later neighbours take the whole remainder. The loop stops after 20 weight slots.
 */
const CURVE_WEIGHTS = [0.25, 0.25, -0.25, -0.25, -0.25, -0.25, -0.25, -0.25, 4.2e-45];
const REDISTRIBUTE_STEPS = 20;
/** Threshold 0x7A0354 (≈1e-7 in game units), in N·m. */
const CURVE_EPSILON = 1e-4;
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
interface TuningRecord {
  item: number; level: number; param: number; type: number; f8: number; fC: number;
  displayMin?: number; displayMax?: number;
}

export type ScalarCategory = 'suspension' | 'aerodynamics' | 'tires-brakes' | 'nitrous';

/**
 * Scalar values use physics units; display fields use the game's metric display scale.
 * The display transform is linear: min/max correspond to displayMin/displayMax.
 * Ride height is in cm (multiply the physics value by 39.37 for the game's inches).
 */
export interface ScalarRow {
  param: number;
  label: string;
  category: ScalarCategory;
  min: number;
  max: number;
  stock: number;
  value: number;
  byte: number;
  minByte: number;
  maxByte: number;
  displayMin: number;
  displayMax: number;
  displayStock: number;
  displayValue: number;
  unit: string;
  /** Some traffic-car records contain inverted bounds; do not offer writes for these rows. */
  editable: boolean;
}

const SCALARS: ReadonlyArray<readonly [number, string, ScalarCategory]> = [
  [0, 'Front springs', 'suspension'], [1, 'Front shocks', 'suspension'],
  [2, 'Front sway bar', 'suspension'], [3, 'Front ride height', 'suspension'],
  [4, 'Rear springs', 'suspension'], [5, 'Rear shocks', 'suspension'],
  [6, 'Rear sway bar', 'suspension'], [7, 'Rear ride height', 'suspension'],
  [8, 'Steering ratio', 'suspension'],
  [16, 'Nitrous duration', 'nitrous'], [17, 'Nitrous flow rate', 'nitrous'],
  [18, 'Brake bias', 'tires-brakes'], [19, 'Front tire grip', 'tires-brakes'],
  [20, 'Rear tire grip', 'tires-brakes'],
  [21, 'Front downforce', 'aerodynamics'], [22, 'Rear downforce', 'aerodynamics'],
];

const scalarOffsets = (param: number): number[] => {
  const offsets: Record<number, number[]> = {
    0: [0x174], 1: [0x178, 0x17c], 2: [0x180], 3: [0x18, 0x48],
    4: [0x194], 5: [0x198, 0x19c], 6: [0x1a0], 7: [0x78, 0xa8],
    8: [0x270], 16: [0x2a0], 17: [0x2ac], 18: [0x27c],
    19: [0xdc, 0xe0], 20: [0xfc, 0x100], 21: [0x264], 22: [0x268],
  };
  return offsets[param];
};

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

/** Event indices in SETUP_NAMES order. */
export type DynoEvent = 0 | 1 | 2 | 3 | 4;

export interface TuningBand {
  minRpm: number;
  maxRpm: number;
  description: string;
}

/** Curves shown by the game's ECU and turbo tuning screens. */
export type CurveKind = 'ecu' | 'turbo';

/** One RPM column of an ECU or turbo curve. Torque values are in N·m. */
export interface CurvePoint {
  rpm: number;
  min: number;
  max: number;
  /** Value at the neutral byte (the game's "Reset to default"); may lie outside min–max, where the game clamps it. */
  stock: number;
  value: number;
  /** Final physics component including uniques: ECU = total minus turbo; turbo = its own curve, without sum restore. */
  effective: number;
  byte: number;
  /** Byte range that still changes the value; bytes outside it are clamped by the game. */
  minByte: number;
  maxByte: number;
}

/** One row of the game's Drivetrain tuning screen: final drive (param 9) or a forward gear (10–15). */
export interface GearRow {
  param: number;
  label: string;
  ratio: number;
  min: number;
  max: number;
  /** Ratio at the neutral byte. */
  stock: number;
  byte: number;
  /** Road speed at the engine's `+0x1F4` rpm in this gear, km/h (`FUN_0059b5c0`); null for final drive. */
  speed: number | null;
  /** Speeds at the ratio limits (max ratio gives min speed), km/h; null for final drive. */
  minSpeed: number | null;
  maxSpeed: number | null;
}

/** Drivetrain screen of a setup. */
export interface Gearing {
  rows: GearRow[];
  /** Gear speed in km/h is `speedFactor / ratio` with the current final drive. */
  speedFactor: number;
}

export interface GearPowerWindow {
  fromGear: number;
  shiftRpm: number;
  landingRpm: number;
  /** Fraction of engine RPM retained across the shift. */
  retention: number;
  /** Mean power across the recovered RPM interval, divided by peak power. */
  powerCoverage: number;
}

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
      displayMin: dv.getFloat32(o + 16, true), displayMax: dv.getFloat32(o + 20, true),
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

/** Writes curves and optionally gearing and/or all scalar controls; other setup bytes remain intact. */
export function setSetupTuning(save: Uint8Array, slot: number, setup: number, bytes: Uint8Array, gearing = false,
  scalars = false): Uint8Array {
  if (bytes.length !== SETUP_SIZE) throw new RangeError(`A setup has ${SETUP_SIZE} bytes.`);
  const out = save.slice();
  const off = setupOffset(slot, setup);
  out.set(bytes.subarray(ECU_OFF, SETUP_SIZE), off + ECU_OFF);
  if (gearing) out.set(bytes.subarray(9, 16), off + 9);
  if (scalars) for (const [param] of SCALARS) out[off + param] = bytes[param];
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
      // FUN_005a6bd0 picks the gear set from the third transmission fraction, not the first.
      const lvl = Math.trunc(out[2] * 3 + 0.5);
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
    ({ f, out } = this.fraction(2, 1));
    if (f) {
      s(p, 0x2a0, g(p, 0x2a0) + (R(c, 0x580) - g(p, 0x2a0)) * out[0]);
      s(p, 0x2ac, R(c, 0x58c));
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
    ({ f, out } = this.fraction(5, 3));
    if (f) {
      for (let axle = 0; axle < 2; axle++) {
        for (let i = 0; i < 8; i++) {
          const off = 0x170 + axle * 0x20 + i * 4;
          const fraction = i === 4 ? out[1] : out[0];
          s(p, off, g(p, off) + (R(c, 0x5c0 + axle * 0x20 + i * 4) - g(p, off)) * fraction);
        }
        for (const off of scalarOffsets(axle ? 7 : 3)) {
          s(p, off, g(p, off) + R(c, axle ? 0x608 : 0x604) * out[0]);
        }
      }
      s(p, 8, g(p, 8) - R(c, 0x600) * out[0]);
      s(p, 0x270, g(p, 0x270) + (R(c, 0x5bc) - g(p, 0x270)) * out[2]);
    }
    ({ f } = this.fraction(6, 1));
    if (f) for (let i = 0; i < 3; i++) {
      const off = 0x274 + i * 4;
      s(p, off, g(p, off) + (R(c, 0x5b0 + i * 4) - g(p, off)) * f);
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
    ({ f } = this.fraction(8, 1));
    if (f) for (const axle of [0, 0x20]) for (const off of [0xd0, 0xd4, 0xd8, 0xdc, 0xe0]) {
      s(p, off + axle, g(p, off + axle) + (R(c, off + axle + 0x470) - g(p, off + axle)) * f);
    }
    ({ f, out } = this.fraction(9, 2));
    if (f) {
      for (let i = 0; i < 3; i++) {
        const off = 0x264 + i * 4;
        s(p, off, g(p, off) + (R(c, 0x590 + i * 4) + R(c, 0x5a0 + i * 4)) * (i < 2 ? out[i] : f));
      }
    }
    // The unique transmission sets the drive bias, and its removal never restores it.
    if (this.uniques[1]) s(p, 0x1c0, R(c, 0x2b4));
    return p;
  }

  private addUniques(p: Phys): void {
    const c = this.car, u = this.uniques;
    if (u[0]) s(p, 0x110, g(p, 0x110) * (1 - R(c, 0x2b0)));
    if (u[2]) s(p, 0x2ac, g(p, 0x2ac) + R(c, 0x2b8));
    if (u[6]) s(p, 0x274, g(p, 0x274) + R(c, 0x2bc));
    if (u[8]) for (const [off, delta] of [[0xdc, 0x2c0], [0xe0, 0x2c8], [0xfc, 0x2c4], [0x100, 0x2cc]]) {
      s(p, off, g(p, off) + R(c, delta));
    }
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

  private modifyBounds(param: number, lo: number, hi: number): [number, number] {
    const rec = this.tuneRecords.get(param);
    if (!rec) return [lo, hi];
    if (rec.type === 2 || rec.type === 3) return [(hi - lo) * rec.f8 + lo, (hi - lo) * rec.fC + hi];
    if (rec.type === 0 || rec.type === 1) return [lo + rec.f8, hi + rec.fC];
    return [Math.min(lo, rec.f8), Math.max(hi, rec.fC)];
  }

  /** FUN_005aca50, with the per-component helpers for shocks and tire grip. */
  private scalarAbsRange(param: number, component?: number): [number, number] {
    const c = this.car;
    if ([1, 5, 19, 20].includes(param)) {
      const offsets = scalarOffsets(param);
      const upgraded = param === 1 ? 0x5c8 : param === 5 ? 0x5e8 : param === 19 ? 0x54c : 0x56c;
      const ranges = offsets.map((off, i) => this.modifyBounds(param, R(c, off), R(c, upgraded + i * 4)));
      return component === undefined
        ? [(ranges[0][0] + ranges[1][0]) / 2, (ranges[0][1] + ranges[1][1]) / 2]
        : ranges[component];
    }
    // Nitrous and brake bias use fixed absolute ranges and skip FUN_0059b160.
    if (param === 16) return [1, 11];
    if (param === 17) return [0.1, 0.9];
    if (param === 18) return [0, 1];
    let values: number[];
    if (param === 0 || param === 4) values = [0x174, 0x194, 0x5c4, 0x5e4].map((off) => R(c, off));
    else if (param === 2 || param === 6) values = [0x180, 0x1a0, 0x5d0, 0x5f0].map((off) => R(c, off));
    else if (param === 3 || param === 7) values = [-R(c, 0x604), -R(c, 0x608), 0];
    else if (param === 8) values = [R(c, 0x270), R(c, 0x5bc)];
    else values = [R(c, 0x264), R(c, 0x268),
      R(c, 0x264) + R(c, 0x590) + R(c, 0x5a0), R(c, 0x268) + R(c, 0x594) + R(c, 0x5a4)];
    return this.modifyBounds(param, Math.min(...values), Math.max(...values));
  }

  private scalarDefault(p: Phys, param: number): number {
    if (param === 3 || param === 7) return R(this.car, scalarOffsets(param)[0]) - g(p, scalarOffsets(param)[0]);
    const offsets = scalarOffsets(param);
    return offsets.reduce((sum, off) => sum + g(p, off), 0) / offsets.length;
  }

  private absRange(p: Phys, param: number): [number, number] {
    if (SCALARS.some(([id]) => id === param)) return this.scalarAbsRange(param);
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
    const d = curve ? (this.curveDefs.get(param) as number[])[i] : this.referenceDefault(param);
    if (curve) [lo, hi] = this.caps(p, param, i, lo, hi);
    let mn: number, mx: number;
    if (rec.type === 0) {
      if (param === 3 || param === 7 || param === 9) { mn = Math.max(lo, d - rec.fC); mx = hi; }
      else { mn = lo; mx = Math.min(hi, d + rec.fC); }
    } else if (rec.type === 1) {
      mn = Math.max(lo, d + rec.f8); mx = Math.min(hi, d + rec.fC);
    } else if (rec.type === 2) {
      if (param === 3 || param === 7 || param === 9) { mn = Math.max(lo, d - (hi - lo) * rec.fC); mx = hi; }
      else { mn = lo; mx = Math.min(hi, d + (hi - lo) * rec.fC); }
    } else if (rec.type === 3) {
      mn = Math.max(lo, d + (hi - lo) * rec.f8);
      mx = Math.min(hi, d + (hi - lo) * rec.fC);
    } else if (rec.type === 4) {
      mn = rec.f8; mx = rec.fC;
    } else {
      throw new Error(`Unsupported tuning record type ${rec.type}.`);
    }
    if (mn === mx) mx += 0.01;
    return [mn, mx];
  }

  /** FUN_005a79f0 uses common reference defaults for these front/rear pairs. */
  private referenceDefault(param: number): number {
    const pair = param === 0 || param === 4 ? [0, 4] : param === 2 || param === 6 ? [2, 6]
      : param === 3 || param === 7 ? [3, 7] : param === 21 || param === 22 ? [21, 22] : [param];
    const defaults = pair.map((id) => this.defs.get(id) ?? 0);
    return param === 3 || param === 7 || param === 9 ? Math.min(...defaults) : Math.max(...defaults);
  }

  private setScalar(p: Phys, param: number, value: number): void {
    const offsets = scalarOffsets(param);
    if (param === 3 || param === 7) {
      for (const off of offsets) s(p, off, R(this.car, off) - value);
    } else if ([1, 5, 19, 20].includes(param)) {
      const [lo, hi] = this.scalarAbsRange(param);
      const t = hi === lo ? 0 : (clamp(value, lo, hi) - lo) / (hi - lo);
      offsets.forEach((off, i) => {
        const [min, max] = this.scalarAbsRange(param, i);
        s(p, off, min + t * (max - min));
      });
    } else {
      s(p, offsets[0], value);
      if (param === 16 || param === 17) {
        const other = param === 16 ? 17 : 16;
        const [lo, hi] = this.range(p, param), [min, max] = this.range(p, other);
        s(p, scalarOffsets(other)[0], (this.defs.get(other) ?? 0)
          - (value - (this.defs.get(param) ?? 0)) * (max - min) / (hi - lo));
      }
    }
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
    for (const [param] of SCALARS) if (this.active(p, param)) this.defs.set(param, this.scalarDefault(p, param));
    const applyScalars = (first: number, last: number): void => {
      for (const [param] of SCALARS) {
        if (param < first || param > last || !this.active(p, param)) continue;
        const [lo, hi] = this.range(p, param);
        this.setScalar(p, param, clamp((hi - lo) * byteT(gearBytes[param]) + this.defs.get(param)!, lo, hi));
        if (param === 16 || param === 17) {
          const other = param === 16 ? 17 : 16;
          if (this.active(p, other)) {
            const [min, max] = this.range(p, other);
            gearBytes[other] = clamp(Math.floor(100.5 + 100
              * (clamp(this.scalarDefault(p, other), min, max) - this.defs.get(other)!) / (max - min)), 0, MAX_TUNE_BYTE);
          }
        }
      }
    };
    applyScalars(0, 8);
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
    applyScalars(16, 22);
    const sum = () => { let t = 0; for (let i = 0; i < 9; i++) t += g(p, 0x200 + 4 * i); return t; };
    const s0 = sum();
    for (const [prm, off] of [[P_ECU, ECU_OFF], [P_TURBO, TURBO_OFF]] as const) {
      if (!this.active(p, prm)) continue;
      this.curveDefs.set(prm, Array.from({ length: 9 }, (_, i) =>
        prm === P_ECU ? g(p, 0x200 + 4 * i) - g(p, 0x224 + 4 * i) : g(p, 0x224 + 4 * i)));
      const defs = this.curveDefs.get(prm) as number[];
      for (let i = 0; i < 9; i++) {
        const [lo, hi] = this.range(p, prm, i);
        const req = (hi - lo) * byteT(setup[off + i]) + defs[i];
        // FUN_005b2c00 writes nothing when the request equals the current point exactly (neutral byte), so a
        // default above the power cap is kept unclamped.
        const cur = prm === P_ECU ? g(p, 0x200 + 4 * i) - g(p, 0x224 + 4 * i) : g(p, 0x224 + 4 * i);
        if (req === cur) continue;
        const v = clamp(req, lo, hi);
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

  /** Unlocked non-curve controls. Display bounds are the editable bounds, not the full scale. */
  scalarTuning(setup: ArrayLike<number>): ScalarRow[] {
    if (setup.length !== SETUP_SIZE) throw new RangeError(`A setup has ${SETUP_SIZE} bytes.`);
    const p = this.tuned(setup);
    return SCALARS.filter(([param]) => this.active(p, param)).map(([param, label, category]) => {
      const rec = this.tuneRecords.get(param)!;
      const [min, max] = this.range(p, param), [lo, hi0] = this.scalarAbsRange(param);
      const hi = hi0 === lo ? hi0 + 0.01 : hi0;
      const stock = this.defs.get(param)!;
      const value = param === 16 || param === 17
        ? this.scalarDefault(p, param) - (param === 17 && this.uniques[2] ? R(this.car, 0x2b8) : 0)
        : clamp(stock + (max - min) * byteT(setup[param]), min, max);
      const metric = param === 3 || param === 7 ? 100 : 1;
      const explicit = (v: number | undefined): v is number => v !== undefined && Math.abs(v + 99.99) > 0.001;
      const displayLo = explicit(rec.displayMin) ? rec.displayMin : lo * metric;
      const displayHi = explicit(rec.displayMax) ? rec.displayMax : hi * metric;
      const display = (v: number) => displayLo + (v - lo) * (displayHi - displayLo) / (hi - lo);
      const toByte = (v: number) => 100 + 100 * (v - stock) / (max - min);
      return {
        param, label, category, min, max, stock, value, byte: setup[param],
        minByte: clamp(Math.ceil(toByte(min) - 1e-6), 0, MAX_TUNE_BYTE),
        maxByte: clamp(Math.floor(toByte(max) + 1e-6), 0, MAX_TUNE_BYTE),
        displayMin: display(min), displayMax: display(max), displayStock: display(stock), displayValue: display(value),
        unit: param === 3 || param === 7 ? 'cm' : param === 16 ? 's' : '',
        editable: Number.isFinite(min) && Number.isFinite(max) && min < max,
      };
    });
  }

  /**
   * Edits a scalar in physics units, preserving the input and unrelated bytes.
   * Nitrous necessarily writes both duration and flow: the game re-encodes the partner on load.
   */
  withScalarValue(setup: ArrayLike<number>, param: number, value: number): Uint8Array {
    if (!Number.isFinite(value)) throw new RangeError('A tuning value must be finite.');
    const rows = this.scalarTuning(setup);
    const row = rows.find((r) => r.param === param);
    if (!row) throw new RangeError('This scalar tuning control is locked or unknown.');
    if (!row.editable) throw new RangeError('Local game data has invalid bounds for this tuning control.');
    const out = Uint8Array.from(setup);
    const encode = (r: ScalarRow, v: number): number => {
      const b = 100 + 100 * (clamp(v, r.min, r.max) - r.stock) / (r.max - r.min);
      return clamp(Math.floor(b + 0.5), r.minByte, r.maxByte);
    };
    out[param] = encode(row, value);
    if (param === 16 || param === 17) {
      const other = rows.find((r) => r.param === (param === 16 ? 17 : 16));
      if (other) {
        const quantized = clamp(row.stock + (row.max - row.min) * byteT(out[param]), row.min, row.max);
        out[other.param] = encode(other, other.stock - (quantized - row.stock)
          * (other.max - other.min) / (row.max - row.min));
      }
    }
    return out;
  }

  /**
   * Editable ECU or turbo curve of a setup, like the game's tuning graph, in N·m.
   * @param setup 41 setup bytes.
   * @param kind Which curve.
   * @returns Nine points, or null when the installed parts do not unlock the curve.
   */
  curve(setup: ArrayLike<number>, kind: CurveKind): CurvePoint[] | null {
    const param = kind === 'ecu' ? P_ECU : P_TURBO, off = kind === 'ecu' ? ECU_OFF : TURBO_OFF;
    const p = this.tuned(setup);
    if (!this.active(p, param)) return null;
    const idle = g(p, 0x1f0), red = g(p, 0x1f8);
    return (this.curveDefs.get(param) as number[]).map((stock, i) => {
      const [min, max] = this.range(p, param, i);
      const span = max - min;
      const toByte = (value: number) => 100 + 100 * (value - stock) / span;
      const value = clamp(span * byteT(setup[off + i]) + stock, min, max);
      return {
        rpm: idle + (red - idle) * i / 8,
        min: min * 1000, max: max * 1000, stock: stock * 1000,
        value: value * 1000,
        effective: (kind === 'ecu' ? g(p, 0x200 + i * 4) - g(p, 0x224 + i * 4) : g(p, 0x224 + i * 4)) * 1000,
        byte: setup[off + i],
        minByte: clamp(Math.ceil(toByte(min) - 1e-6), 0, MAX_TUNE_BYTE),
        maxByte: clamp(Math.floor(toByte(max) + 1e-6), 0, MAX_TUNE_BYTE),
      };
    });
  }

  /**
   * Setup byte whose curve point is nearest a value, within the point's effective byte range.
   * @param point Point from {@link curve}.
   * @param nm Wanted value in N·m.
   */
  static curveByte(point: CurvePoint, nm: number): number {
    if (point.maxByte <= point.minByte) return point.minByte;
    const at = (b: number) => DynoModel.curveValue(point, b);
    let best = point.minByte;
    for (let b = point.minByte; b <= point.maxByte; b++) if (Math.abs(at(b) - nm) < Math.abs(at(best) - nm)) best = b;
    return best;
  }

  /**
   * Value in N·m that a setup byte gives a curve point.
   * @param point Point from {@link curve}.
   * @param byte Setup byte.
   */
  static curveValue(point: CurvePoint, byte: number): number {
    return clamp(point.stock + byteT(byte) * (point.max - point.min), point.min, point.max);
  }

  /**
   * Sets one ECU or turbo point like the game's tuning screen (FUN_005b2c00 with redistribution): the point is
   * clamped to its range, then neighbours absorb the requested change so the curve's sum is kept.
   * @param setup 41 setup bytes.
   * @param kind Which curve.
   * @param index Point 0–8.
   * @param nm Wanted value in N·m.
   * @returns Edited setup bytes; unchanged when the curve is locked.
   */
  withCurvePoint(setup: ArrayLike<number>, kind: CurveKind, index: number, nm: number): Uint8Array {
    const out = Uint8Array.from(setup);
    const points = this.curve(setup, kind);
    if (!points) return out;
    const cur = points.map((pt) => pt.value);
    const delta = nm - cur[index];
    cur[index] = clamp(nm, points[index].min, points[index].max);
    if (Math.abs(delta) > CURVE_EPSILON) {
      let remaining = delta, k = 0, w = 0;
      do {
        if (w >= REDISTRIBUTE_STEPS) break;
        let amt = -remaining;
        if (w < CURVE_WEIGHTS.length) {
          amt = delta * CURVE_WEIGHTS[w];
          amt = remaining <= 0 ? Math.max(amt, remaining) : Math.min(amt, remaining);
        }
        k = -k;
        if (k >= 0 && ++k > 8) k = 1;
        const n = index + k;
        if (n >= 0 && n < 9) {
          const nv = clamp(cur[n] + amt, points[n].min, points[n].max);
          w++;
          remaining += nv - cur[n];
          cur[n] = nv;
        }
      } while (Math.abs(remaining) > CURVE_EPSILON);
    }
    const off = kind === 'ecu' ? ECU_OFF : TURBO_OFF;
    points.forEach((pt, i) => {
      if (Math.abs(cur[i] - pt.value) > CURVE_EPSILON) out[off + i] = DynoModel.curveByte(pt, cur[i]);
    });
    return out;
  }

  /**
   * Final drive and forward gears of a setup, like the game's Drivetrain screen.
   * @param setup 41 setup bytes.
   * @returns Unlocked rows, or null when the installed parts unlock no gearing.
   */
  gearing(setup: ArrayLike<number>): Gearing | null {
    const p = this.tuned(setup);
    const params = this.gearingParameters.filter((prm) => this.defs.has(prm)).sort((a, b) => (a === 9 ? 1 : 0) - (b === 9 ? 1 : 0));
    if (!params.length) return null;
    const speedFactor = DynoModel.ratioAt(p, 1) * 3.6;
    const names = ['1st', '2nd', '3rd', '4th', '5th', '6th'];
    return {
      speedFactor,
      rows: params.map((param) => {
        const [min, max] = this.range(p, param);
        const ratio = param === 9 ? g(p, 0x1b8) : g(p, 0x1b0 + param * 4);
        const gear = param !== 9;
        return {
          param, label: gear ? `${names[param - 10]} gear` : 'Final drive', ratio, min, max,
          stock: this.defs.get(param) as number, byte: setup[param],
          speed: gear ? speedFactor / ratio : null,
          minSpeed: gear ? speedFactor / max : null,
          maxSpeed: gear ? speedFactor / min : null,
        };
      }),
    };
  }

  /**
   * Sets one gearing ratio like the game's tuning screen setter (`FUN_005b4670`): the value is clamped to
   * its range; a gear also moves its neighbours to keep the minimum spacing, then every active gear is
   * re-encoded. Final drive only re-encodes its own byte.
   * @param setup 41 setup bytes (not modified).
   * @param param 9 final drive, 10–15 forward gears.
   * @param ratio Wanted ratio.
   * @returns New setup bytes.
   */
  withGearRatio(setup: ArrayLike<number>, param: number, ratio: number): Uint8Array {
    const out = Uint8Array.from(setup);
    const p = this.tuned(setup);
    const encode = (prm: number, value: number): void => {
      const def = this.defs.get(prm) as number;
      const [min, max] = this.range(p, prm);
      out[prm] = clamp(Math.floor(100.5 + 100 * (clamp(value, min, max) - def) / (max - min)), 0, MAX_TUNE_BYTE);
    };
    if (!this.defs.has(param) || !Number.isFinite(ratio)) return out;
    if (param === 9) {
      encode(9, ratio);
      return out;
    }
    this.setGear(p, ratio, param);
    for (let gear = 10; gear <= 15; gear++) if (this.defs.has(gear)) encode(gear, g(p, 0x1b0 + gear * 4));
    return out;
  }

  /** Power-band coverage for every forward shift, including those outside a timed run. */
  gearPowerWindows(setup: ArrayLike<number>): GearPowerWindow[] {
    const p = this.tuned(setup);
    const { tab, idle, inv } = torqueTable(p);
    const peak = peaks(p).peakPower;
    const sh = shiftPoints(p);
    const power = (rpm: number) => interp(tab, idle, inv, rpm) * rpm * RAD_PER_RPM;
    return Array.from({ length: Math.max(0, p.gearCount - 1) }, (_, i) => {
      const retention = g(p, 0x1dc + 4 * i) / g(p, 0x1d8 + 4 * i);
      const shiftRpm = sh[i + 2] - 100;
      const landingRpm = shiftRpm * retention;
      // Integrate over the RPM recovered after shifting, rather than judging just peak power.
      const steps = Math.max(1, Math.ceil((shiftRpm - landingRpm) / 50));
      let sum = 0;
      for (let j = 0; j <= steps; j++) {
        sum += power(landingRpm + (shiftRpm - landingRpm) * j / steps) * (j === 0 || j === steps ? 0.5 : 1);
      }

      return { fromGear: i + 1, shiftRpm, landingRpm, retention,
        powerCoverage: peak > 0 ? clamp(sum / steps / peak, 0, 1) : 0 };
    });
  }

  tuningBand(setup: ArrayLike<number>, event: DynoEvent): TuningBand {
    if (!Number.isInteger(event) || event < 0 || event >= SETUP_COUNT) throw new RangeError('Select a valid dyno event.');
    const p = this.tuned(setup), idle = g(p, 0x1f0), red = g(p, 0x1f8), span = red - idle;
    const windows = this.gearPowerWindows(setup);
    const recovery = windows.length ? Math.min(...windows.map((w) => w.landingRpm)) : idle + span * 0.5;
    // Event targets are editor heuristics, not constants from the game or wiki.
    const low = event === 2 ? 0.2 : event === 3 ? 0.25 : event === 1 ? 0.5 : 0.35;
    const high = event === 2 ? 0.75 : event === 3 ? 0.85 : 1;
    return {
      minRpm: event === 2 || event === 3 ? idle + span * low :
        Math.max(idle + span * low, Math.min(recovery, idle + span * 0.65)),
      maxRpm: idle + span * high,
      description: [
        'Circuit: broad power through corner exits and shift recovery.',
        'Drag: sustained high-RPM power and top-speed-biased gearing.',
        'Drift: low–mid RPM response and acceleration-biased gearing.',
        'Street X: low–mid RPM recovery for short tracks.',
        'URL: broad usable power across repeated shifts.',
      ][event],
    };
  }

  /** Geometric mean of three band averages: a single RPM peak cannot replace low/mid-band power. */
  usablePower(setup: ArrayLike<number>, band: TuningBand): number {
    if (!(band.maxRpm > band.minRpm)) throw new RangeError('The tuning RPM band must have positive width.');
    const p = this.tuned(setup), { tab, idle, inv } = torqueTable(p);
    const averages = Array.from({ length: 3 }, (_, i) => {
      const lo = band.minRpm + (band.maxRpm - band.minRpm) * i / 3;
      const hi = band.minRpm + (band.maxRpm - band.minRpm) * (i + 1) / 3;
      const steps = Math.max(1, Math.ceil((hi - lo) / 50));
      let sum = 0;
      for (let j = 0; j <= steps; j++) {
        const rpm = lo + (hi - lo) * j / steps;
        sum += Math.max(0, interp(tab, idle, inv, rpm) * rpm * RAD_PER_RPM) * (j === 0 || j === steps ? 0.5 : 1);
      }
      return sum / steps;
    });
    return Math.cbrt(averages[0] * averages[1] * averages[2]);
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

// Single-precision port of FUN_005b06a0 in the game's operation order. The game keeps every state variable
// (speed, distance, time, shift counter) in float32 and runs the x87 at 24-bit precision, so each operation
// rounds to float32. Differences to a double simulation: the shift counter (+-1/60 * 3 / 1.5) reaches
// 0.99999994 instead of 1.0 after 40 recovery steps, which costs one extra cut/power frame pair per gear
// change, and the cut branch requires counter > 0 (not >= 0).
const fr = Math.fround;

function interp32(table: ArrayLike<number>, x0: number, invDx: number, x: number): number {
  const t = fr(fr(x - x0) * invDx);
  const i = Math.trunc(t);
  if (i < 0 || !(t >= 0)) return table[0];
  if (i >= table.length - 1) return table[table.length - 1];
  const f = fr(t - i);
  return fr(fr(f * table[i + 1]) + fr(fr(1 - f) * table[i]));
}

function dragSim(p: Phys, carIndex: number): Pick<DynoResult, 't60' | 't100' | 'quarterMile' | 'trapSpeed' | 'quarterExact'> {
  const G = (o: number): number => fr(g(p, o));
  const tab = Array.from({ length: 9 }, (_, i) => G(0x200 + 4 * i));
  const idle = G(0x1f0), red = G(0x1f8), shift = G(0x1f4);
  const inv = fr(8 / fr(red - idle));
  const bias = G(0x1c0), nb = fr(1 - bias);
  const fd = fr(fr(bias * G(0x1bc)) + fr(nb * G(0x1b8)));
  const invR = fr(1 / fr(fr(nb * G(0x20)) + fr(bias * G(0x80))));
  const n = p.gearCount;
  const sh: number[] = [];
  for (let k = 2; k <= n; k++) sh[k] = fr(shift - 100);
  sh[n + 1] = fr(red + 500);
  const mass = G(0x110), k = G(0x260);
  const gears = Array.from({ length: n }, (_, i) => G(0x1d8 + 4 * i));
  const dt = fr(1 / 60), mph = fr(MPH), cut = [fr(-3), 0, fr(1.5)];
  let gear = 0, v = 0, x = 0, t = 0, c = 1, phase = 1, just = false;
  let t60 = 0, t100 = 0, qm = 0, trap = 0, qmExact = Infinity;
  for (let step = 0; step < 0xf423f; step++) {
    const gr = gears[gear] ?? 0;
    const rpm = fr(fr(fr(fr(invR * v) * gr) * fd) * fr(9.549304));
    let a: number;
    const thr = sh[gear + 2] === undefined ? NaN : fr(-100 + sh[gear + 2]);
    if (just || !(thr < rpm)) {
      just = false;
      a = fr(fr(fr(fr(interp32(tab, idle, inv, rpm) * gr) * fd) * invR) / mass);
    } else {
      just = true;
      c = fr(fr(dt * cut[phase ? 0 : 2]) + c);
      if (c > 0) {
        just = c < 1;
        if (!just) { gear++; c = 1; phase = 1; }
      } else {
        c = 0; phase = 0;
      }
      a = 0;
    }
    t = fr(dt + t);
    const dv = fr(fr(a - fr(fr(fr(v * k) * v) / mass)) * dt);
    x = fr(fr(fr(fr(0.5 * dv) + v) * dt) + x);
    v = fr(dv + v);
    if (t60 === 0 && 60 <= fr(v * mph)) t60 = fr(t * fr(F60[carIndex] ?? 0));
    if (t100 === 0 && 100 <= fr(v * mph)) t100 = fr(t * fr(F100[carIndex] ?? 0));
    if (qm === 0 && QUARTER_MILE_M <= x) {
      qm = t; trap = v;
      qmExact = t - (x - QUARTER_MILE_M) / Math.max(v, 1e-6);
    }
    if (t60 !== 0 && t100 !== 0 && qm !== 0 && trap !== 0) break;
  }
  const z = (q: number): number => (q === 0 ? Infinity : q);
  return { t60: z(t60), t100: z(t100), quarterMile: z(qm), trapSpeed: trap * MPH, quarterExact: qmExact };
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
  // FUN_005b5ab0 zeroes the last computed force, spans the n forces over [0, vmax] with n-1 intervals (spacing
  // vmax/(n-1), not SPEED_STEP) and resamples them to the 64-point table that FUN_005b5930 walks while sp <= vmax.
  const n = forces.length;
  forces[n - 1] = 0;
  const TOP_N = 64;
  const res = Array.from({ length: TOP_N }, (_, i) => interp(forces, 0, (n - 1) / vmax, i * vmax / (TOP_N - 1)));
  let sp = 0;
  while (sp <= vmax && sp * k * sp / mass <= interp(res, 0, (TOP_N - 1) / vmax, sp)) sp += SPEED_STEP;
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
 * Optional gearing balances the selected goal with all-shift power coverage and RPM spacing.
 * Peak output is independent of gearing.
 * @param model Dyno model of the car.
 * @param setup Current 41 setup bytes.
 * @param goal What to optimize.
 * @param gearing Whether to include final drive and unlocked forward gears.
 * @returns Optimized setup bytes and the results before and after.
 */
export function optimizeSetup(model: DynoModel, setup: ArrayLike<number>, goal: DynoGoal = 'quarter', gearing = false):
  { setup: Uint8Array; before: DynoResult; after: DynoResult } {
  return searchSetup(model, setup, goal, gearing);
}

function searchSetup(model: DynoModel, setup: ArrayLike<number>, goal: DynoGoal, gearing: boolean,
  objective: (result: DynoResult, bytes: Uint8Array) => number = (result) => score(result, goal),
  accepts: (result: DynoResult) => boolean = () => true, budgetReference?: DynoResult, limitGoalLoss = true):
  { setup: Uint8Array; before: DynoResult; after: DynoResult } {
  const indices: number[] = [];
  const gearIndices = gearing && goal !== 'power' && goal !== 'torque' ? model.gearingParameters : [];
  indices.push(...gearIndices);
  if (model.ecuTunable) for (let i = 0; i < CURVE_POINTS; i++) indices.push(ECU_OFF + i);
  if (model.turboTunable) for (let i = 0; i < CURVE_POINTS; i++) indices.push(TURBO_OFF + i);
  const start = Uint8Array.from(setup);
  const before = model.evaluate(start);
  if (!indices.length) return { setup: start, before, after: before };

  const reference = start.slice();
  for (const idx of gearIndices) reference[idx] = NEUTRAL_BYTE;
  const referenceWindows = gearIndices.some((idx) => idx !== 9) ? model.gearPowerWindows(reference) : [];
  const evenRetention = referenceWindows.length
    ? Math.pow(referenceWindows.reduce((product, window) => product * window.retention, 1), 1 / referenceWindows.length) : 0;
  const initialScore = objective(budgetReference ?? before, start);
  const scale = Number.isFinite(initialScore) ? Math.max(1, Math.abs(initialScore)) : 1;
  const evalScore = (bytes: Uint8Array) => {
    const result = model.evaluate(bytes);
    if (!accepts(result)) return Infinity;
    const value = objective(result, bytes);
    if (!referenceWindows.length) return value;
    if (limitGoalLoss && Number.isFinite(initialScore) && value > initialScore + scale * 0.05) return Infinity;
    const windows = model.gearPowerWindows(bytes);
    // Do not trade an unvisited shift's RPM drop for a better short-run result.
    if (windows.some((window, i) => !Number.isFinite(window.retention) || window.retention <= 0 ||
      window.retention >= 1 || window.retention < Math.min(referenceWindows[i].retention, evenRetention) - 1e-6)) return Infinity;
    const gaps = windows.map((window) => -Math.log(window.retention));
    const meanGap = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
    const unevenness = gaps.reduce((sum, gap) => sum + (gap - meanGap) ** 2, 0) / gaps.length / (meanGap ** 2);
    const meanCoverage = windows.reduce((sum, window) => sum + window.powerCoverage, 0) / windows.length;
    const worstCoverage = Math.min(...windows.map((window) => window.powerCoverage));
    return value / scale + 0.2 * (1 - meanCoverage) + 0.4 * (1 - worstCoverage) + 0.1 * unevenness;
  };
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
  if (referenceWindows.length) seeds.push(reference);
  for (const fill of [NEUTRAL_BYTE, 0, MAX_TUNE_BYTE]) {
    const seed = start.slice();
    for (const idx of indices) seed[idx] = fill;
    seeds.push(seed);
  }
  let best: { bytes: Uint8Array; value: number } = { bytes: start, value: evalScore(start) };
  for (const seed of seeds) {
    const r = descend(seed);
    if (r.value < best.value - 1e-9) best = r;
  }
  if (referenceWindows.length && !Number.isFinite(best.value)) {
    throw new Error(`No smooth gearing setup was found${limitGoalLoss ? ' within the 5% performance budget' : ''}. Disable gearing optimization or reset the gear tuning and try again.`);
  }
  return { setup: best.bytes, before, after: model.evaluate(best.bytes) };
}

/**
 * Tunes usable power for the selected event, then optional gearing and a guarded band refinement.
 * The reference RPM band stays fixed during a run so gearing cannot game the objective.
 */
export function optimizeDynoSetup(model: DynoModel, setup: ArrayLike<number>, event: DynoEvent = 0, gearing = false):
  { setup: Uint8Array; before: DynoResult; after: DynoResult; band: TuningBand; stages: { power: DynoResult; goal: DynoResult } } {
  const band = model.tuningBand(setup, event);
  const power = searchSetup(model, setup, 'power', false, (_r, bytes) => -model.usablePower(bytes, band));
  const bandReference = Math.max(model.usablePower(power.setup, band), 1e-6);
  const weights = event === 1 ? [0.05, 0.1, 0.35, 0.5] :
    event === 2 || event === 3 ? [0.6, 0.25, 0.1, 0.05] : [0.2, 0.2, 0.3, 0.3];
  const baseline = power.after;
  const timeTerm = (value: number, reference: number, weight: number) =>
    Number.isFinite(reference) ? weight * value / Math.max(reference, 1e-6) : 0;
  const objective = (r: DynoResult, bytes: Uint8Array) =>
    -model.usablePower(bytes, band) / bandReference + 0.2 * (
    timeTerm(r.t60, baseline.t60, weights[0]) + timeTerm(r.t100, baseline.t100, weights[1]) +
    timeTerm(r.quarterExact, baseline.quarterExact, weights[2]) -
    weights[3] * r.topSpeed / Math.max(baseline.topSpeed, 1));
  let goal = searchSetup(model, power.setup, 'quarter', gearing, objective, () => true, power.after, false);
  goal = searchSetup(model, goal.setup, 'quarter', gearing, objective, () => true, power.after, false);
  const target = goal.after;
  const noSlower = (r: DynoResult) => r.t60 <= target.t60 && r.t100 <= target.t100 &&
    r.quarterMile <= target.quarterMile && r.quarterExact <= target.quarterExact &&
    r.topSpeed >= target.topSpeed && r.trapSpeed >= target.trapSpeed;
  const refined = searchSetup(model, goal.setup, 'power', false, (_r, bytes) => -model.usablePower(bytes, band), noSlower);
  return { setup: refined.setup, before: power.before, after: refined.after,
    band, stages: { power: power.after, goal: goal.after } };
}

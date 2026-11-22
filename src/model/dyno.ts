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
// Float32 variant for the gear decode (FUN_0059aee0, FUN_005b4780): (b-100)*0.01f.
const byteT32 = (b: number): number => clamp(Math.fround(Math.fround(b - 100) * Math.fround(0.01)), -1, 1);
/**
 * Gear and final-drive byte encoder of FUN_005b3ee0 -> FUN_0059af80, in float32:
 * trunc(((ratio - def) / (max - min)) * 100f + 100.5f), with the ratio clamped to its range first.
 */
const encodeGearByte = (ratio: number, def: number, min: number, max: number): number => {
  const f = Math.fround;
  const frac = f(f(f(clamp(ratio, min, max)) - f(def)) / f(f(max) - f(min)));
  return clamp(Math.floor(f(f(frac * 100) + 100.5)), 0, MAX_TUNE_BYTE);
};

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
    // FUN_0059b5c0 works in float32 with the constant stored at 0x7A1D38 (44 77 D6 3D = 0.10471966862678528, the
    // float nearest to 2*pi/60 but not exactly equal to it), not the power factor 0.10471204.
    const f = Math.fround, b = f(bias);
    const r = b < f(0.2) ? f(g(p, 0x50)) : b > f(0.8) ? f(g(p, 0x80))
      : f(f(f(1 - b) * f(g(p, 0x50))) + f(f(g(p, 0x80)) * b));
    const w = f(f(g(p, 0x1f4)) * f(0.10471966862678528));
    return f(f(r / f(speed)) * f(w / f(g(p, 0x1b8))));
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



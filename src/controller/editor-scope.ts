import type { Donor } from '../model/cars.js';
import type { ChecksumStatus } from '../model/save-file.js';
import type { SlotState } from '../model/slots.js';
import type { PerfPart, UniquePerfPart } from '../data/perf-parts.js';
import type { CurveKind, DynoEvent } from '../model/dyno.js';

/** Result of a donor-list or file-load problem, shown in the status line. */
export interface Status {
  type: '' | 'success' | 'error';
  text: string;
}

/** Summary of one car slot, as the view renders it. */
export interface SlotView {
  index: number;
  used: boolean;
  locked: boolean;
  bought: boolean;
  state: SlotState;
  key: string;
  car: Donor | null;
  trafficName: string;
  perfCount: number;
  uniqueCount: number;
  unlocked: number;
}

/** One performance part row in the tuning dialog. */
export interface PartView extends PerfPart {
  on: boolean;
  offset: string;
  relativeOffset: string;
  packageLabel: string;
  purchased: boolean;
  purchaseOffset: string;
  purchaseMask: string;
}

export interface UniquePartView extends UniquePerfPart {
  on: boolean;
  value: number;
  hexValue: string;
  offset: string;
  relativeOffset: string;
}

/** One performance category in the tuning dialog. */
export interface CategoryView {
  code: string;
  label: string;
  parts: PartView[];
  onCount: number;
  activeCount: number;
  unique: UniquePartView | null;
}

/** One dyno value in metric and imperial units; `imperial` is empty for unit-free values. */
export interface DynoCell {
  metric: string;
  imperial: string;
  rpm: string;
}

/** One row of the dyno result table. */
export interface DynoRow {
  label: string;
  /** Metric equivalent of the label, e.g. `0–97 km/h`. */
  sub: string;
  before: DynoCell;
  after: DynoCell | null;
  better: boolean;
}

/** One RPM column of the ECU/turbo graph, in SVG units. */
export interface CurveColumn {
  index: number;
  x: number;
  width: number;
  /** Top and height of the allowed min–max range. */
  rangeY: number;
  rangeH: number;
  stockY: number;
  valueY: number;
  valueH: number;
  /** Value after the load's sum restore; differs from valueY only for independently set points. */
  effY: number;
  rpmLabel: string;
}

/** ECU or turbo graph in the dyno tab. */
export interface CurveChart {
  width: number;
  height: number;
  /** Plot area. */
  left: number;
  top: number;
  bottom: number;
  /** Value in N·m at the top of the plot area. */
  yMax: number;
  ticks: { y: number; label: string }[];
  columns: CurveColumn[];
  /** Selected column details, formatted. */
  selected: {
    rpm: string; value: string; stock: string; range: string; change: string; canDown: boolean; canUp: boolean;
    /** Value in game after the sum restore, or empty when it equals the set value. */
    effective: string;
    /** The effective value lies outside the game's range. */
    beyond: boolean;
  };
}

/** Graph tab of the dyno editor: an ECU/turbo curve or the drivetrain screen. */
export type DynoTab = CurveKind | 'drive';

/** One drivetrain row; positions are percentages of the bar width. */
export interface GearBar {
  param: number;
  label: string;
  value: string;
  sub: string;
  final: boolean;
  /** Allowed range. */
  lo: number;
  hi: number;
  at: number;
  stock: number;
}

/** Drivetrain screen in the dyno tab. */
export interface GearChart {
  rows: GearBar[];
  /** Speed scale of the gear bars, km/h. */
  ticks: { at: number; label: string }[];
  selected: { label: string; value: string; stock: string; range: string; downLabel: string; upLabel: string; canDown: boolean; canUp: boolean };
}

/** State of the dyno tab. */
export interface DynoView {
  gameName: string;
  gameError: string;
  setup: DynoEvent;
  setupNames: string[];
  strategy: string;
  optimizeGearing: boolean;
  carName: string;
  /** Empty when the car can be tuned, else the reason it cannot. */
  blocked: string;
  busy: boolean;
  rows: DynoRow[];
  /** True when the draft differs from the saved setup. */
  hasProposal: boolean;
  /** Curves unlocked by the installed parts. */
  curveTabs: { kind: DynoTab; label: string }[];
  curve: DynoTab;
  /**
   * Save-only curve editing: points are set independently, which the game UI never does. Off follows the game's
   * tuning screen, where neighbours absorb a point's change.
   */
  cheat: boolean;
  point: number;
  chart: CurveChart | null;
  /** Selected drivetrain row. */
  gear: number;
  drive: GearChart | null;
}

/** Top-level tuning tab. */
export interface TuningTab {
  code: string;
  label: string;
}

/** Profile choice for an nfsu2-web backup ZIP. */
export interface BackupView {
  current: number;
  note: string;
  profiles: { index: number; label: string }[];
}

/** State and actions the editor template binds to. */
export interface EditorScope extends angular.IScope {
  loaded: boolean;
  fileName: string;
  fileSize: number;
  checks: ChecksumStatus | null;
  backup: BackupView | null;
  status: Status;
  form: { name: string; money: number };
  slots: SlotView[];
  perfTotal: number;
  uniqueTotal: number;
  unlockTotal: number;
  swapTarget: Record<number, number | string | undefined>;
  replaceTarget: Record<number, number | string | undefined>;
  donors: Donor[];
  replacementCars: { id: number | string; name: string; group: string; experimental: boolean }[];
  tuning: {
    open: boolean;
    slot: number;
    tabs: TuningTab[];
    tab: string;
    sub: string;
    categories: CategoryView[];
    dyno: DynoView;
  };

  loadFile(file: File | null): void;
  selectProfile(index: number): void;
  checksumText(): string;
  usedCount(): number;
  applyProfile(): void;
  openTuning(slot: number): void;
  selectTab(code: string): void;
  selectSub(code: string): void;
  activeTabLabel(): string;
  toggleUnlocks(slot: number): void;
  toggleLock(slot: number): void;
  closeTuning(): void;
  togglePart(part: PartView): void;
  toggleUnique(part: UniquePartView): void;
  maxOut(slot: number): void;
  swapSlots(slot: number): void;
  replaceCar(slot: number): void;
  loadGameData(file: File | null): void;
  selectSetup(setup: DynoEvent): void;
  optimizeDyno(): void;
  applyDyno(): void;
  discardDyno(): void;
  selectCurve(kind: DynoTab): void;
  selectGear(index: number): void;
  /** Positive is faster for a gear and towards Acceleration for final drive. */
  stepGear(delta: number): void;
  gearPointer(event: MouseEvent, index: number, start: boolean): void;
  gearKey(event: KeyboardEvent): void;
  selectPoint(index: number): void;
  stepPoint(delta: number): void;
  resetCurve(): void;
  curvePointer(event: MouseEvent, start: boolean): void;
  curveKey(event: KeyboardEvent): void;
  download(): void;
}

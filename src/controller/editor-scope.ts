import type { Donor } from '../model/cars.js';
import type { ChecksumStatus } from '../model/save-file.js';
import type { SlotState } from '../model/slots.js';
import type { PerfPart, UniquePerfPart } from '../data/perf-parts.js';
import type { DynoGoal } from '../model/dyno.js';

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

/** State of the dyno tab. */
export interface DynoView {
  gameName: string;
  gameError: string;
  setup: number;
  setupNames: string[];
  goal: DynoGoal;
  optimizeGearing: boolean;
  carName: string;
  /** Empty when the car can be tuned, else the reason it cannot. */
  blocked: string;
  busy: boolean;
  rows: DynoRow[];
  hasProposal: boolean;
}

/** Top-level tuning tab. */
export interface TuningTab {
  code: string;
  label: string;
}

/** State and actions the editor template binds to. */
export interface EditorScope extends angular.IScope {
  loaded: boolean;
  fileName: string;
  fileSize: number;
  checks: ChecksumStatus | null;
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
  selectSetup(setup: number): void;
  setGoal(): void;
  optimizeDyno(): void;
  applyDyno(): void;
  download(): void;
}

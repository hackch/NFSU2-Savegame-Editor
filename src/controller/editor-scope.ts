import type { Donor } from '../model/cars.js';
import type { ChecksumStatus } from '../model/save-file.js';
import type { SlotState } from '../model/slots.js';
import type { PerfPart, UniquePerfPart } from '../data/perf-parts.js';

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
  tuning: {
    open: boolean;
    slot: number;
    tabs: TuningTab[];
    tab: string;
    sub: string;
    categories: CategoryView[];
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
  setCategory(cat: CategoryView, on: boolean): void;
  installAll(slot: number, on: boolean): void;
  swapSlots(slot: number): void;
  replaceCar(slot: number): void;
  download(): void;
}

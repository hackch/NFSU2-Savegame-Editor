import type { Donor } from '../model/cars.js';
import type { ChecksumStatus } from '../model/save-file.js';

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
  key: string;
  car: Donor | null;
  perfCount: number;
  unlocked: number;
}

/** One performance part row in the tuning dialog. */
export interface PartView {
  index: number;
  label: string;
  verified: boolean;
  on: boolean;
}

/** One performance category in the tuning dialog. */
export interface CategoryView {
  code: string;
  label: string;
  parts: PartView[];
  onCount: number;
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
  unlockAllSlots(): void;
  closeTuning(): void;
  togglePart(part: PartView): void;
  setCategory(cat: CategoryView, on: boolean): void;
  installAll(slot: number, on: boolean): void;
  swapSlots(slot: number): void;
  replaceCar(slot: number): void;
  download(): void;
}

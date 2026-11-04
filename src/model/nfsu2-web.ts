/**
 * nfsu2-web backup support. Its runtime/garage.c stores career slots 6-10 beside each profile as GARAGE.DAT:
 * `N2GA`, version 1, FNV-1a 64 of the profile's car part, career/Quick Race/stand-in handles, then five native records.
 */
import { checkSave } from './save-file.js';
import { EXTENDED_SAVE_SIZE, EXTRA_SLOT_RECORD_BASE, PROFILE_SIZE, SLOT_COUNT, SLOT_STRIDE, dataView } from './layout.js';
import type { ZipEntry } from './zip.js';

export const GARAGE_FILE = 'GARAGE.DAT';
export const GARAGE_MAGIC = [0x4e, 0x32, 0x47, 0x41];
export const GARAGE_HEADER_SIZE = 32;
export const GARAGE_SIZE = GARAGE_HEADER_SIZE + SLOT_COUNT * SLOT_STRIDE;
/** The profile payload starts after the 20CM header and payload metadata. */
export const PROFILE_PAYLOAD_OFF = 36;
/** Length of the payload's car part fingerprinted by nfsu2-web. */
export const PROFILE_CARS_PART_SIZE = 39230;

export type GarageState = 'loaded' | 'missing' | 'stale' | 'invalid';

/** A career profile found in an nfsu2-web backup ZIP. */
export interface BackupProfile {
  name: string;
  folder: string;
  careerEntry: number;
  garageEntry: number;
  garageState: GarageState;
  note: string;
}

/**
 * FNV-1a 64 of the profile's car part, as nfsu2-web uses to pair GARAGE.DAT with a profile.
 * @param career 54,966-byte career save.
 * @returns Unsigned 64-bit fingerprint.
 */
export function garageFingerprint(career: Uint8Array): bigint {
  if (career.length < PROFILE_PAYLOAD_OFF + PROFILE_CARS_PART_SIZE) throw new RangeError('Career save is too small for a GARAGE.DAT fingerprint.');
  let hash = 0xcbf29ce484222325n;
  for (let i = PROFILE_PAYLOAD_OFF; i < PROFILE_PAYLOAD_OFF + PROFILE_CARS_PART_SIZE; i++) {
    hash ^= BigInt(career[i]);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash;
}

/** Reads the fingerprint stored in GARAGE.DAT. */
export function storedGarageFingerprint(garage: Uint8Array): bigint {
  const v = dataView(garage);
  return BigInt(v.getUint32(8, true)) | (BigInt(v.getUint32(12, true)) << 32n);
}

function setGarageFingerprint(garage: Uint8Array, career: Uint8Array): void {
  const fp = garageFingerprint(career);
  const v = dataView(garage);
  v.setUint32(8, Number(fp & 0xffffffffn), true);
  v.setUint32(12, Number(fp >> 32n), true);
}

/**
 * Checks whether nfsu2-web would load a GARAGE.DAT for this career save.
 * @param garage GARAGE.DAT bytes.
 * @param career Career save bytes.
 * @returns Its state and a message for the page.
 */
export function checkGarage(garage: Uint8Array, career: Uint8Array): { state: Exclude<GarageState, 'missing'>; note: string } {
  if (career.length !== PROFILE_SIZE) return { state: 'invalid', note: `Career saves with GARAGE.DAT must be ${PROFILE_SIZE} bytes.` };
  if (garage.length !== GARAGE_SIZE || GARAGE_MAGIC.some((byte, i) => garage[i] !== byte) || dataView(garage).getUint32(4, true) !== 1) {
    return { state: 'invalid', note: 'GARAGE.DAT is not an nfsu2-web version 1 garage; slots 6-10 were left unchanged.' };
  }
  if (storedGarageFingerprint(garage) !== garageFingerprint(career)) {
    return { state: 'stale', note: 'GARAGE.DAT belongs to another version of this profile; nfsu2-web would not load slots 6-10, so they were left unchanged.' };
  }
  return { state: 'loaded', note: 'nfsu2-web GARAGE.DAT loaded: slots 6-10 are available.' };
}

/** Joins a career save and its five GARAGE.DAT records into the editor's 10-slot working buffer. */
export function mergeGarage(career: Uint8Array, garage: Uint8Array): Uint8Array {
  const check = checkGarage(garage, career);
  if (check.state !== 'loaded') throw new RangeError(check.note);
  const out = new Uint8Array(EXTENDED_SAVE_SIZE);
  out.set(career);
  out.set(garage.subarray(GARAGE_HEADER_SIZE), EXTRA_SLOT_RECORD_BASE);
  return out;
}

/**
 * Rebuilds GARAGE.DAT from the working buffer and final career save.
 * @param original Original GARAGE.DAT; its car-handle header fields are retained.
 * @param working 10-slot working buffer.
 * @param career Final career bytes, after checksum recalculation.
 * @returns A new GARAGE.DAT with a matching fingerprint.
 */
export function buildGarage(original: Uint8Array, working: Uint8Array, career: Uint8Array): Uint8Array {
  if (working.length !== EXTENDED_SAVE_SIZE) throw new RangeError('The working save has no GARAGE.DAT slots.');
  const out = original.slice();
  out.set(working.subarray(EXTRA_SLOT_RECORD_BASE, EXTENDED_SAVE_SIZE), GARAGE_HEADER_SIZE);
  setGarageFingerprint(out, career);
  return out;
}

/**
 * Finds career profiles in an nfsu2-web save-folder ZIP: `<profile>/<profile>`, normally under `NFS Underground 2/`.
 * @param entries ZIP entries.
 * @returns Valid 20CM profiles and their optional GARAGE.DAT status.
 */
export function findBackupProfiles(entries: ZipEntry[]): BackupProfile[] {
  const profiles: BackupProfile[] = [];
  entries.forEach((entry, careerEntry) => {
    const parts = entry.name.split('/');
    if (parts.length < 2) return;
    const name = parts[parts.length - 1];
    const dir = parts[parts.length - 2];
    if (!name || name !== dir || !checkSave(entry.data).ok) return;
    const folder = parts.slice(0, -1).join('/');
    const garageName = `${folder}/${GARAGE_FILE}`.toLowerCase();
    const garageEntry = entries.findIndex((other) => other.name.toLowerCase() === garageName);
    if (garageEntry < 0) {
      profiles.push({ name, folder, careerEntry, garageEntry, garageState: 'missing', note: 'No GARAGE.DAT: only career slots 1-5 are stored for this profile.' });
      return;
    }
    const check = checkGarage(entries[garageEntry].data, entry.data);
    profiles.push({ name, folder, careerEntry, garageEntry, garageState: check.state, note: check.note });
  });
  return profiles;
}

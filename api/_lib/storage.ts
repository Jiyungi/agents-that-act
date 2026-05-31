/**
 * Shared Storage_Service factory for the serverless functions (Person B).
 *
 * The gallery (`/api/scans`), record persistence (`/api/scan-records`), and the
 * report proxy (`/api/report`) all read/write Tigris through the same
 * {@link TigrisStorageService}. A single lazily-created instance is reused
 * across warm serverless invocations.
 */

import { TigrisStorageService } from "../../shared/storage.js";

let singleton: TigrisStorageService | undefined;

/** Lazily create (and cache) the Tigris-backed Storage_Service. */
export function getStorage(): TigrisStorageService {
  if (singleton === undefined) {
    singleton = new TigrisStorageService();
  }
  return singleton;
}

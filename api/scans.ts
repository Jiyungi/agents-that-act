/**
 * Vercel serverless function `GET /api/scans` (Person B, task 12.2).
 *
 * Returns the gallery: a {@link GalleryResult} of stored Scan_Records, capped
 * at 100, newest-first, one record per scanned version (Req 9). Semantics:
 *   - empty store        → `{ records: [], partial: false, unavailable: false }`
 *   - some records fail  → the rest with `partial: true` (Req 9.4)
 *   - store unreachable  → `{ records: [], partial: false, unavailable: true }`
 *                          (Req 9.8)
 *
 * All gallery logic lives in {@link TigrisStorageService.listScans}; this
 * handler only parses the optional `limit` and maps to an HTTP response.
 */

import type { GalleryResult } from "../shared/scan.js";
import { getStorage } from "./_lib/storage.js";

export interface ScansRequest {
  method?: string | undefined;
  query?: Record<string, string | string[] | undefined> | undefined;
}

export interface ScansResponse {
  status(code: number): ScansResponse;
  json(payload: unknown): unknown;
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Pure adapter: resolve a request to `{ status, body }` (unit-testable). */
export async function scansToHttp(
  req: ScansRequest,
): Promise<{ status: number; body: GalleryResult }> {
  const rawLimit = firstParam(req.query?.["limit"]);
  const parsed = rawLimit !== undefined ? Number(rawLimit) : undefined;
  const limit =
    parsed !== undefined && Number.isInteger(parsed) && parsed >= 0
      ? parsed
      : undefined;

  const result = await getStorage().listScans(limit !== undefined ? { limit } : {});
  return { status: 200, body: result };
}

export default async function handler(
  req: ScansRequest,
  res: ScansResponse,
): Promise<void> {
  const { status, body } = await scansToHttp(req);
  res.status(status).json(body);
}

/**
 * Vercel serverless function `POST /api/scan-records` (Person B, task 12.1).
 *
 * Persists a {@link ScanRecord} via the Storage_Service (Req 7.5). In the
 * primary PackGuard flow the local agent's upload trigger uploads the report +
 * snapshot AND persists the record itself, so this endpoint is the serverless
 * persistence path for clients that produce a record out-of-band. It validates
 * the identifier and frozen verdict fields, then writes `records/{name}/{ver}`.
 *
 *   POST /api/scan-records   body: ScanRecord
 *     200 { scanRecord }
 *     400 { errorType: INVALID_IDENTIFIER, message }
 *     502 { errorType: UPLOAD_FAILED, message }
 */

import type { ScanRecord } from "@shared/scan";
import { StorageError } from "@shared/storage";
import { UploadErrorType } from "@shared/errors";
import { getStorage } from "./_lib/storage.js";

export interface ScanRecordsRequest {
  method?: string | undefined;
  body?: unknown;
}

export interface ScanRecordsResponse {
  status(code: number): ScanRecordsResponse;
  json(payload: unknown): unknown;
}

interface ErrorBody {
  errorType: UploadErrorType;
  message: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export async function scanRecordsToHttp(
  req: ScanRecordsRequest,
): Promise<{ status: number; body: { scanRecord: ScanRecord } | ErrorBody }> {
  const body =
    typeof req.body === "string"
      ? safeParse(req.body)
      : asRecord(req.body);

  if (body === undefined) {
    return {
      status: 400,
      body: {
        errorType: UploadErrorType.INVALID_IDENTIFIER,
        message: "request body must be a Scan_Record object",
      },
    };
  }

  try {
    const { scanRecord } = await getStorage().persistRecord(body as unknown as ScanRecord);
    return { status: 200, body: { scanRecord } };
  } catch (err) {
    if (err instanceof StorageError && err.errorType === UploadErrorType.INVALID_IDENTIFIER) {
      return { status: 400, body: { errorType: err.errorType, message: err.message } };
    }
    return {
      status: 502,
      body: {
        errorType: UploadErrorType.UPLOAD_FAILED,
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

function safeParse(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text);
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

export default async function handler(
  req: ScanRecordsRequest,
  res: ScanRecordsResponse,
): Promise<void> {
  const { status, body } = await scanRecordsToHttp(req);
  res.status(status).json(body);
}

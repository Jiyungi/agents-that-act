/**
 * In-memory `StorageService` fake (test/integration double for Tigris).
 *
 * Implements the `Storage_Service` contract from design.md → "Interface 4 —
 * Storage_Service API". It lets Person A's upload trigger (task 7.2) and
 * Person B's UI/gallery (tasks 14/15) integrate against an agreed shape
 * *before* the real Tigris-backed service (task 11.1) exists. The real
 * cross-person wiring that removes this fake is task 17.1.
 *
 * Deliberately dependency-free: no `@aws-sdk/client-s3`, no network, no disk.
 * Everything is held in process memory.
 */

import type { GalleryResult, ScanRecord } from "../scan.js";
import type { ReportSchema } from "../report.js";
import { UploadErrorType } from "../errors.js";
import { CONFIG_DEFAULTS } from "../config.js";

/**
 * Storage_Service contract (design.md → Interface 4). Defined here, in the
 * testing subpath, so the fake has a named shape to implement before the
 * production service lands. When task 11.1 ships the real Tigris service it
 * can implement this same shape; task 17.1 then removes the stub.
 */
export interface StorageService {
  /**
   * Upload report + source snapshot and persist a Scan_Record (Req 7). The
   * `report` is assumed already normalized to {@link ReportSchema}.
   */
  uploadScan(input: {
    report: ReportSchema;
    reportBytes: Buffer;
    sourceSnapshot: Buffer;
  }): Promise<{ scanRecord: ScanRecord }>;

  /** Public URL for a stored report, or `null` if none exists (Req 8). */
  getPublicReportUrl(
    packageName: string,
    version: string,
  ): Promise<string | null>;

  /** Gallery list (Interface 5 / Req 9). */
  listScans(input?: { limit?: number }): Promise<GalleryResult>;
}

/** Maximum records returned by the gallery list per request (Req 9.1). */
export const GALLERY_MAX_RECORDS = 100;

/**
 * Typed storage error so callers (e.g. the upload trigger) can branch on the
 * agreed {@link UploadErrorType} value set (design.md → Error Handling).
 */
export class StorageError extends Error {
  readonly errorType: UploadErrorType;
  constructor(errorType: UploadErrorType, message?: string) {
    super(message ?? errorType);
    this.name = "StorageError";
    this.errorType = errorType;
  }
}

/**
 * URL-encode a package name so a scoped `@scope/name` maps to a single safe
 * key segment that decodes back to the original (Req 1.6, Property 6). The
 * production encode/decode lives with the name validator (task 2.1); this is
 * a fake-local helper so the double can build keys today.
 */
export function encodeName(packageName: string): string {
  return encodeURIComponent(packageName);
}

/** Tigris report key: `reports/{encodedName}/{version}/report.json` (Req 7.3). */
export function reportKeyFor(packageName: string, version: string): string {
  return `reports/${encodeName(packageName)}/${version}/report.json`;
}

/** Tigris source key: `sources/{encodedName}/{version}/source.tgz` (Req 7.4). */
export function sourceKeyFor(packageName: string, version: string): string {
  return `sources/${encodeName(packageName)}/${version}/source.tgz`;
}

export interface InMemoryStorageOptions {
  /**
   * Threshold T frozen into each Scan_Record at creation (Req 13.5). Defaults
   * to the design default (50).
   */
  thresholdUsed?: number;
  /**
   * Base URL used to mint `publicReportUrl` values. Defaults to the Tigris
   * endpoint + bucket so minted URLs look like the real public-bucket URLs.
   */
  publicUrlBase?: string;
  /**
   * When `false`, no public URL is minted and records are persisted with
   * `publicReportUrl = null`, exercising the Req 8.2 fallback. Defaults to
   * `true`.
   */
  mintPublicUrl?: boolean;
}

interface StoredScan {
  scanRecord: ScanRecord;
  reportBytes: Buffer;
  sourceSnapshot: Buffer;
}

/**
 * In-memory implementation of {@link StorageService}.
 *
 * Records are keyed by `{encodedName}/{version}` so each scanned version gets
 * its own entry (Req 9.3) and re-uploading the same name+version overwrites.
 */
export class InMemoryStorageService implements StorageService {
  private readonly store = new Map<string, StoredScan>();
  private readonly thresholdUsed: number;
  private readonly publicUrlBase: string;
  private readonly mintPublicUrl: boolean;

  constructor(options: InMemoryStorageOptions = {}) {
    this.thresholdUsed = options.thresholdUsed ?? CONFIG_DEFAULTS.RISK_THRESHOLD;
    this.publicUrlBase =
      options.publicUrlBase ??
      `${CONFIG_DEFAULTS.TIGRIS_ENDPOINT}/${CONFIG_DEFAULTS.TIGRIS_BUCKET}`;
    this.mintPublicUrl = options.mintPublicUrl ?? true;
  }

  async uploadScan(input: {
    report: ReportSchema;
    reportBytes: Buffer;
    sourceSnapshot: Buffer;
  }): Promise<{ scanRecord: ScanRecord }> {
    const { report, reportBytes, sourceSnapshot } = input;
    const packageName = report.packageName?.trim() ?? "";
    const version = report.version?.trim() ?? "";

    // Reject missing/empty identifiers without persisting a record (Req 7.6).
    if (packageName === "" || version === "") {
      throw new StorageError(
        UploadErrorType.INVALID_IDENTIFIER,
        "uploadScan requires a non-empty packageName and version",
      );
    }

    const reportKey = reportKeyFor(report.packageName, report.version);
    const sourceKey = sourceKeyFor(report.packageName, report.version);
    const publicReportUrl = this.mintPublicUrl
      ? `${this.publicUrlBase}/${reportKey}`
      : null;

    const scanRecord: ScanRecord = {
      packageName: report.packageName,
      version: report.version,
      verdict: report.verdict,
      riskScore: report.riskScore,
      thresholdUsed: this.thresholdUsed,
      publicReportUrl,
      reportKey,
      sourceKey,
      createdAt: new Date().toISOString(), // UTC ISO-8601 (Reqs 7.5, 8.5)
    };

    this.store.set(this.keyOf(report.packageName, report.version), {
      scanRecord,
      reportBytes,
      sourceSnapshot,
    });

    return { scanRecord };
  }

  async getPublicReportUrl(
    packageName: string,
    version: string,
  ): Promise<string | null> {
    const stored = this.store.get(this.keyOf(packageName, version));
    return stored?.scanRecord.publicReportUrl ?? null;
  }

  async listScans(input?: { limit?: number }): Promise<GalleryResult> {
    const requested = input?.limit;
    const cap =
      requested !== undefined && Number.isInteger(requested) && requested >= 0
        ? Math.min(requested, GALLERY_MAX_RECORDS)
        : GALLERY_MAX_RECORDS;

    const records = [...this.store.values()]
      .map((stored) => stored.scanRecord)
      .slice(0, cap);

    // The in-memory fake never partially fails and is always reachable.
    return { records, partial: false, unavailable: false };
  }

  /** Number of stored scans (test helper). */
  get size(): number {
    return this.store.size;
  }

  /** Clear all stored scans (test helper). */
  reset(): void {
    this.store.clear();
  }

  private keyOf(packageName: string, version: string): string {
    return `${encodeName(packageName)}/${version}`;
  }
}

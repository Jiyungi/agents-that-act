/**
 * Storage_Service — the canonical Interface 4 contract (design.md) plus the
 * real Tigris-backed implementation (Person B, tasks 11/12; Reqs 7, 8, 9).
 *
 * Tigris is S3-compatible, so this wraps `@aws-sdk/client-s3` pointed at the
 * Tigris endpoint (default `https://t3.storage.dev`, region `auto`). It is used
 * by:
 *   - the local agent's upload trigger (writes: `uploadScan`), and
 *   - the serverless gallery / report endpoints (reads: `listScans`,
 *     `getPublicReportUrl`, plus the report proxy).
 *
 * Object key layout (Reqs 7.3, 7.4; design.md → Interface 4):
 *   reports/{encodedName}/{version}/report.json   -> Public_Report_URL target
 *   sources/{encodedName}/{version}/source.tgz     -> Source_Snapshot
 *   records/{encodedName}/{version}.json           -> Scan_Record
 *
 * `encodedName` URL-encodes `@scope/name` into one safe key segment (Req 1.6).
 *
 * Retry / fallback policy (Reqs 7.7, 8.2):
 *   - report + source + record uploads each retry up to 3 attempts; if the
 *     report upload fails on all 3, NO Scan_Record is persisted (throws).
 *   - public-URL minting is best-effort; on failure the record persists with
 *     `publicReportUrl = null`.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

import type { GalleryResult, ScanRecord } from "./scan.js";
import type { ReportSchema, Verdict } from "./report.js";
import { UploadErrorType } from "./errors.js";
import { encodePackageName } from "./package-name.js";
import { loadConfig, type PackGuardConfig } from "./config.js";

/**
 * Storage_Service contract (design.md → Interface 4). The real
 * {@link TigrisStorageService} and the in-memory test fake both implement it.
 */
export interface StorageService {
  /** Upload report + source snapshot and persist a Scan_Record (Req 7). */
  uploadScan(input: {
    report: ReportSchema;
    reportBytes: Buffer;
    sourceSnapshot: Buffer;
  }): Promise<{ scanRecord: ScanRecord }>;
  /** Public URL for a stored report, or `null` if none exists (Req 8). */
  getPublicReportUrl(packageName: string, version: string): Promise<string | null>;
  /** Gallery list (Interface 5 / Req 9). */
  listScans(input?: { limit?: number }): Promise<GalleryResult>;
}

/** Maximum records returned by the gallery list per request (Req 9.1). */
export const GALLERY_MAX_RECORDS = 100;

/** Max attempts for a single Tigris operation (Reqs 7.7, 8.2). */
export const MAX_STORAGE_ATTEMPTS = 3;

/** Typed storage error carrying the agreed {@link UploadErrorType} value. */
export class StorageError extends Error {
  readonly errorType: UploadErrorType;
  constructor(errorType: UploadErrorType, message?: string) {
    super(message ?? errorType);
    this.name = "StorageError";
    this.errorType = errorType;
  }
}

/** Tigris report key: `reports/{encodedName}/{version}/report.json` (Req 7.3). */
export function reportKeyFor(packageName: string, version: string): string {
  return `reports/${encodePackageName(packageName)}/${version}/report.json`;
}

/** Tigris source key: `sources/{encodedName}/{version}/source.tgz` (Req 7.4). */
export function sourceKeyFor(packageName: string, version: string): string {
  return `sources/${encodePackageName(packageName)}/${version}/source.tgz`;
}

/** Tigris record key: `records/{encodedName}/{version}.json` (Req 7.5). */
export function recordKeyFor(packageName: string, version: string): string {
  return `records/${encodePackageName(packageName)}/${version}.json`;
}

/** Records-prefix used to list the gallery. */
export const RECORDS_PREFIX = "records/";

/**
 * Build the Public_Report_URL for a stored report. Defaults to a same-origin
 * proxy (`/api/report?...`) which serves the report through our serverless
 * function (works regardless of Tigris public-bucket configuration). Override
 * with `PUBLIC_REPORT_URL_BASE` to point at a real public Tigris domain, in
 * which case the URL becomes `{base}/{reportKey}`.
 */
export function publicReportUrlFor(
  packageName: string,
  version: string,
  publicUrlBase?: string,
): string {
  if (publicUrlBase && publicUrlBase.trim() !== "") {
    const base = publicUrlBase.replace(/\/+$/, "");
    return `${base}/${reportKeyFor(packageName, version)}`;
  }
  return `/api/report?packageName=${encodeURIComponent(
    packageName,
  )}&version=${encodeURIComponent(version)}`;
}

/** Run an async op up to {@link MAX_STORAGE_ATTEMPTS} times; rethrow last error. */
async function withRetries<T>(
  op: () => Promise<T>,
  attempts: number = MAX_STORAGE_ATTEMPTS,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Collect a Tigris/S3 GetObject body stream into a Buffer. */
async function streamToBuffer(body: unknown): Promise<Buffer> {
  if (body === undefined || body === null) return Buffer.alloc(0);
  // Node.js stream (most common with @aws-sdk/client-s3 in Node).
  const maybeStream = body as {
    [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>;
    transformToByteArray?: () => Promise<Uint8Array>;
  };
  if (typeof maybeStream.transformToByteArray === "function") {
    return Buffer.from(await maybeStream.transformToByteArray());
  }
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export interface TigrisStorageOptions {
  /** Full config; defaults to {@link loadConfig}. */
  config?: PackGuardConfig;
  /** Pre-built S3 client (injectable for tests). */
  client?: S3Client;
  /** Public URL base override (else `PUBLIC_REPORT_URL_BASE` env, else proxy). */
  publicUrlBase?: string;
}

/** Real Tigris (S3-compatible) implementation of {@link StorageService}. */
export class TigrisStorageService implements StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly threshold: number;
  private readonly publicUrlBase: string | undefined;

  constructor(options: TigrisStorageOptions = {}) {
    const config = options.config ?? loadConfig();
    this.bucket = config.tigrisBucket;
    this.threshold = config.riskThreshold;
    this.publicUrlBase =
      options.publicUrlBase ?? process.env["PUBLIC_REPORT_URL_BASE"] ?? undefined;
    this.client =
      options.client ??
      new S3Client({
        endpoint: config.tigrisEndpoint,
        region: "auto",
        credentials: {
          accessKeyId: config.awsAccessKeyId,
          secretAccessKey: config.awsSecretAccessKey,
        },
      });
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

    const reportKey = reportKeyFor(packageName, version);
    const sourceKey = sourceKeyFor(packageName, version);
    const recordKey = recordKeyFor(packageName, version);

    // Store the NORMALIZED report (conforms to ReportSchema, includes the
    // derived verdict) at the public report key so the shareable URL + verdict
    // card render fully. The raw operator bytes are kept alongside for audit.
    const normalizedBytes = Buffer.from(JSON.stringify(report), "utf8");

    // 1) Upload the report (≤3 attempts). On total failure → no record (Req 7.7).
    await withRetries(() =>
      this.put(reportKey, normalizedBytes, "application/json", true),
    );

    // 1b) Keep the raw operator report for audit (best-effort, never blocks).
    try {
      await this.put(
        `reports/${encodePackageName(packageName)}/${version}/raw-report`,
        reportBytes,
        "application/octet-stream",
        false,
      );
    } catch {
      // non-fatal
    }

    // 2) Upload the source snapshot (≤3 attempts).
    await withRetries(() =>
      this.put(sourceKey, sourceSnapshot, "application/gzip", false),
    );

    // 3) Mint the public URL — best-effort (Req 8.2 → null on failure).
    let publicReportUrl: string | null = null;
    try {
      publicReportUrl = publicReportUrlFor(packageName, version, this.publicUrlBase);
    } catch {
      publicReportUrl = null;
    }

    const scanRecord: ScanRecord = {
      packageName,
      version,
      verdict: report.verdict as Verdict,
      riskScore: report.riskScore,
      thresholdUsed: this.threshold,
      publicReportUrl,
      reportKey,
      sourceKey,
      createdAt: new Date().toISOString(), // UTC ISO-8601 (Reqs 7.5, 8.5)
    };

    // 4) Persist the Scan_Record (≤3 attempts).
    await withRetries(() =>
      this.put(
        recordKey,
        Buffer.from(JSON.stringify(scanRecord), "utf8"),
        "application/json",
        false,
      ),
    );

    return { scanRecord };
  }

  async getPublicReportUrl(
    packageName: string,
    version: string,
  ): Promise<string | null> {
    try {
      const record = await this.getRecord(packageName, version);
      return record?.publicReportUrl ?? null;
    } catch {
      return null;
    }
  }

  async listScans(input?: { limit?: number }): Promise<GalleryResult> {
    const requested = input?.limit;
    const cap =
      requested !== undefined && Number.isInteger(requested) && requested >= 0
        ? Math.min(requested, GALLERY_MAX_RECORDS)
        : GALLERY_MAX_RECORDS;

    let keys: string[];
    try {
      keys = await this.listRecordKeys(cap);
    } catch {
      // Store unreachable → unavailable, no partial data (Req 9.8).
      return { records: [], partial: false, unavailable: true };
    }

    const records: ScanRecord[] = [];
    let partial = false;
    for (const key of keys) {
      try {
        const buf = await this.get(key);
        if (buf === null) {
          partial = true;
          continue;
        }
        records.push(JSON.parse(buf.toString("utf8")) as ScanRecord);
      } catch {
        // Some records failed to load → return the rest with partial (Req 9.4).
        partial = true;
      }
    }

    // Newest first.
    records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { records: records.slice(0, cap), partial, unavailable: false };
  }

  /**
   * Persist a Scan_Record JSON directly (used by `/api/scan-records`, Req
   * 7.5/12.1). Rejects a missing/empty identifier with INVALID_IDENTIFIER and
   * does not write (Req 7.6). Retries up to 3 attempts (Req 7.7).
   */
  async persistRecord(record: ScanRecord): Promise<{ scanRecord: ScanRecord }> {
    const packageName = record.packageName?.trim() ?? "";
    const version = record.version?.trim() ?? "";
    if (packageName === "" || version === "") {
      throw new StorageError(
        UploadErrorType.INVALID_IDENTIFIER,
        "persistRecord requires a non-empty packageName and version",
      );
    }
    const recordKey = recordKeyFor(packageName, version);
    await withRetries(() =>
      this.put(
        recordKey,
        Buffer.from(JSON.stringify(record), "utf8"),
        "application/json",
        false,
      ),
    );
    return { scanRecord: record };
  }

  /**
   * Delete a stored scan's record + report + source (demo cleanup helper).
   * Best-effort per object; ignores missing keys.
   */
  async deleteScan(packageName: string, version: string): Promise<void> {
    const keys = [
      recordKeyFor(packageName, version),
      reportKeyFor(packageName, version),
      sourceKeyFor(packageName, version),
      `reports/${encodePackageName(packageName)}/${version}/raw-report`,
    ];
    for (const key of keys) {
      try {
        await this.client.send(
          new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
        );
      } catch {
        // best-effort
      }
    }
  }

  /** Fetch + parse the stored report JSON for the report proxy endpoint. */
  async getReport(packageName: string, version: string): Promise<ReportSchema | null> {
    try {
      const buf = await this.get(reportKeyFor(packageName, version));
      if (buf === null) return null;
      return JSON.parse(buf.toString("utf8")) as ReportSchema;
    } catch {
      return null;
    }
  }

  private async getRecord(
    packageName: string,
    version: string,
  ): Promise<ScanRecord | null> {
    const buf = await this.get(recordKeyFor(packageName, version));
    if (buf === null) return null;
    return JSON.parse(buf.toString("utf8")) as ScanRecord;
  }

  private async put(
    key: string,
    body: Buffer,
    contentType: string,
    publicRead: boolean,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ...(publicRead ? { ACL: "public-read" } : {}),
      }),
    );
  }

  /** GET an object; returns `null` when it does not exist. */
  private async get(key: string): Promise<Buffer | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return await streamToBuffer(res.Body);
    } catch (err) {
      const name = (err as { name?: string }).name ?? "";
      if (name === "NoSuchKey" || name === "NotFound") return null;
      throw err;
    }
  }

  private async listRecordKeys(cap: number): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: RECORDS_PREFIX,
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of res.Contents ?? []) {
        if (obj.Key && obj.Key.endsWith(".json")) keys.push(obj.Key);
      }
      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken !== undefined && keys.length < cap * 2);
    return keys;
  }
}

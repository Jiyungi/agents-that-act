/**
 * Upload-trigger CORE logic (Person A, task 7.2).
 *
 * Implements **Interface 3 — Upload-Trigger Interface** (design.md). After the
 * MANUAL Opsera scan writes a `Scan_Report` to `contract.reportPath`, the
 * `Frontend_UI` invokes the agent's `POST /local/upload`; that route handler
 * (in {@link ./server.ts}) is kept THIN and delegates to {@link runUploadTrigger}
 * here so the REPORT_MISSING / 30s-timeout / cleanup branches are unit-testable
 * WITHOUT HTTP.
 *
 * Behaviour (Reqs 6.3–6.6):
 *  1. INVALID_IDENTIFIER guard — the resolved {@link ScanResultContract} must
 *     carry a non-empty `packageName` and `version` (Req 7.6 / Error-Handling
 *     table). The server adds the unknown/missing-`uploadId` guard on top.
 *  2. REPORT_MISSING guard (Req 6.5) — if NO report exists at `reportPath`,
 *     return `REPORT_MISSING` and DO NOT call the Storage_Service.
 *  3. Normalize the raw report → {@link ReportSchema} and derive the verdict
 *     via the INJECTED `normalizeReport` (Person B's task 9.1/10.1). A present
 *     but out-of-range `riskScore` is rejected as `INVALID_RISK_SCORE`
 *     (Req 13.6); an ABSENT score is fail-safe-defaulted, not rejected
 *     (Req 12.5). See the injectable-seam note below.
 *  4. Build the `Source_Snapshot` (a gzipped tar of the extracted source) and
 *     hand `{ report, reportBytes, sourceSnapshot }` to the Storage_Service
 *     (Interface 4). On confirmation return `{ scanRecord }` (Reqs 6.3, 6.4).
 *  5. UPLOAD_FAILED (Req 6.6) — if storage does not confirm within 30s or
 *     fails, return `UPLOAD_FAILED` and RETAIN the report at `reportPath`
 *     (i.e. DO NOT call `cleanup`).
 *  6. On a CONFIRMED success, call the stored `cleanup()` to remove the
 *     retained `./scan-target/` (Req 4.7) — best-effort, never fails the upload.
 *
 * ── INJECTABLE SEAM: normalizeReport + storageService (TEMPORARY STUB) ─────
 * Person B owns the real report normalizer + verdict deriver (tasks 9.1/10.1)
 * and the real Tigris-backed Storage_Service (task 11.1). They DO NOT EXIST
 * yet. So both are INJECTED here:
 *   - `storageService` is required (tests inject `InMemoryStorageService`; final
 *     wiring injects the real Tigris service at task 17.1).
 *   - `normalizeReport` defaults to {@link defaultStubNormalizeReport} — a
 *     MINIMAL, clearly-marked TEMPORARY placeholder that lets the route work
 *     end-to-end against the storage fake. **It MUST be replaced by Person B's
 *     real normalizer at integration task 17.1.** It is intentionally not a
 *     full implementation of Reqs 12/13.
 *
 * ── SAFETY: never execute fetched content while snapshotting ───────────────
 * The snapshot builder ({@link defaultMakeSourceSnapshot}) only READS bytes off
 * disk (`fs.readFile`) and streams them through `tar-stream` + `node:zlib`
 * gzip. It NEVER requires/imports/evaluates/spawns any fetched file, and it
 * NEVER follows symlinks (the Extractor already wrote links as inert
 * placeholders). This preserves the "inspect without installing" guarantee.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createGzip } from "node:zlib";

import { pack as createTarPack } from "tar-stream";

import { UploadErrorType } from "@shared/errors";
import { CONFIG_DEFAULTS } from "@shared/config";
import type { ReportSchema, Severity, Verdict } from "@shared/report";
import type { ScanRecord, ScanResultContract } from "@shared/scan";
// StorageService is the agreed Interface 4 shape (design.md). It lives in the
// testing subpath today; this is a TYPE-ONLY import (erased at runtime under
// verbatimModuleSyntax) so the production agent never bundles the fake. Task
// 11.1 ships a real implementation of this same shape; task 17.1 injects it.
import type { StorageService } from "@shared/testing/storage-fake";

/** Default confirm timeout for the Storage_Service upload (Req 6.6: 30s). */
export const DEFAULT_UPLOAD_CONFIRM_TIMEOUT_MS = 30_000;

/** Placeholder filled in for a missing required string field (Req 12.5). */
const PLACEHOLDER_STRING = "unknown";

/** The ordered, case-sensitive severity set (Req 12.7). */
const SEVERITIES: readonly Severity[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

/**
 * Result of normalizing a raw Opsera report. Either a schema-conformant
 * {@link ReportSchema}, or a rejection for a present-but-invalid `riskScore`
 * (Req 13.6 → {@link UploadErrorType.INVALID_RISK_SCORE}).
 */
export type NormalizeReportResult =
  | { ok: true; report: ReportSchema }
  | {
      ok: false;
      errorType: typeof UploadErrorType.INVALID_RISK_SCORE;
      message: string;
    };

/**
 * The injectable normalizer seam. Maps untrusted raw Opsera output → the
 * normalized {@link ReportSchema} (with verdict derived). Person B's real
 * implementation lands at tasks 9.1/10.1; see {@link defaultStubNormalizeReport}.
 */
export type NormalizeReport = (raw: unknown) => NormalizeReportResult;

/** Result of probing/reading the report at `reportPath`. */
export interface ReadReportResult {
  /** Whether a report file exists at the path (Req 6.5 guard). */
  exists: boolean;
  /** Raw report bytes when it exists (stored verbatim as `reportBytes`). */
  bytes?: Buffer;
}

/** Injectable report reader (default: fs-based {@link defaultReadReport}). */
export type ReadReportFn = (reportPath: string) => Promise<ReadReportResult>;

/** Injectable source-snapshot builder (default: {@link defaultMakeSourceSnapshot}). */
export type MakeSnapshotFn = (sourcePath: string) => Promise<Buffer>;

/** Inputs for {@link runUploadTrigger}. Deps are injectable for tests/wiring. */
export interface RunUploadTriggerDeps {
  /** The active scan's Scan_Result_Contract (resolved from `uploadId`). */
  contract: ScanResultContract;
  /**
   * Bound scan-target cleanup (Req 4.7). Called ONLY after a confirmed upload;
   * on UPLOAD_FAILED the report is retained and this is NOT called (Req 6.6).
   */
  cleanup: () => Promise<void>;
  /** Storage_Service (Interface 4). Required — inject the fake in tests. */
  storageService: StorageService;
  /** Report normalizer + verdict deriver. Defaults to the TEMPORARY stub. */
  normalizeReport?: NormalizeReport;
  /** Report reader. Defaults to the fs-based reader. */
  readReport?: ReadReportFn;
  /** Source-snapshot builder. Defaults to the tar+gzip builder. */
  makeSnapshot?: MakeSnapshotFn;
  /** Storage confirm timeout (ms). Defaults to 30s (Req 6.6). */
  timeoutMs?: number;
}

/**
 * Discriminated result of {@link runUploadTrigger}. Never throws across its
 * boundary; the four failure modes map onto {@link UploadErrorType}.
 */
export type UploadTriggerResult =
  | { ok: true; scanRecord: ScanRecord }
  | { ok: false; errorType: UploadErrorType; message: string };

/** Narrow an unknown value to a non-empty trimmed string, else `fallback`. */
function nonEmptyStringOr(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed === "" ? fallback : trimmed;
}

/**
 * TEMPORARY STUB normalizer (task 7.2 seam) — **replace with Person B's real
 * normalizer (tasks 9.1/10.1) at integration task 17.1.**
 *
 * It does the MINIMUM needed to make `POST /local/upload` work end-to-end
 * against the Storage_Service fake:
 *  - `riskScore`: ABSENT → fail-safe default 100 (Req 12.5); PRESENT but not an
 *    integer in 0..100 → reject with INVALID_RISK_SCORE (Req 13.6).
 *  - `verdict`: derived from `riskScore` vs the threshold `T`
 *    (`riskScore < T` → SAFE, else RISKY) (Req 13.2/13.3).
 *  - required strings / findings: light fail-safe defaulting (Req 12.5).
 *
 * This is NOT a faithful implementation of Reqs 12/13 — it is deliberately
 * minimal and exists only so Person A can integrate before Person B ships.
 */
export function createStubNormalizeReport(
  threshold: number = CONFIG_DEFAULTS.RISK_THRESHOLD,
): NormalizeReport {
  return (raw: unknown): NormalizeReportResult => {
    const obj: Record<string, unknown> =
      typeof raw === "object" && raw !== null
        ? (raw as Record<string, unknown>)
        : {};

    // riskScore: absent → default 100; present-but-out-of-range → reject.
    const rawScore = obj["riskScore"];
    let riskScore: number;
    if (rawScore === undefined || rawScore === null) {
      riskScore = 100; // fail-safe pessimistic default (Req 12.5)
    } else if (
      typeof rawScore === "number" &&
      Number.isInteger(rawScore) &&
      rawScore >= 0 &&
      rawScore <= 100
    ) {
      riskScore = rawScore;
    } else {
      return {
        ok: false,
        errorType: UploadErrorType.INVALID_RISK_SCORE,
        message: `riskScore must be an integer in 0..100; got ${String(rawScore)}`,
      };
    }

    const verdict: Verdict = riskScore < threshold ? "SAFE" : "RISKY";

    const findings = Array.isArray(obj["findings"])
      ? (obj["findings"] as unknown[]).map(stubNormalizeFinding)
      : [];

    return {
      ok: true,
      report: {
        packageName: nonEmptyStringOr(obj["packageName"], PLACEHOLDER_STRING),
        version: nonEmptyStringOr(obj["version"], PLACEHOLDER_STRING),
        verdict,
        riskScore,
        findings,
      },
    };
  };
}

/** Light fail-safe defaulting for a single raw finding (stub; see above). */
function stubNormalizeFinding(raw: unknown): ReportSchema["findings"][number] {
  const obj: Record<string, unknown> =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};

  const rawLine = obj["lineNumber"];
  const lineNumber =
    typeof rawLine === "number" && Number.isInteger(rawLine) && rawLine >= 0
      ? rawLine
      : 0; // missing/invalid → 0 (Req 12.5)

  const rawSeverity = obj["severity"];
  const severity: Severity =
    typeof rawSeverity === "string" && (SEVERITIES as readonly string[]).includes(rawSeverity)
      ? (rawSeverity as Severity)
      : "CRITICAL"; // missing → CRITICAL (Req 12.5)

  const rawSnippet = obj["codeSnippet"];
  const codeSnippet = typeof rawSnippet === "string" ? rawSnippet : "";

  return {
    category: nonEmptyStringOr(obj["category"], PLACEHOLDER_STRING),
    filePath: nonEmptyStringOr(obj["filePath"], PLACEHOLDER_STRING),
    lineNumber,
    severity,
    codeSnippet,
  };
}

/**
 * The default TEMPORARY stub normalizer instance (threshold = config default).
 * **Replace with Person B's real normalizer at task 17.1.**
 */
export const defaultStubNormalizeReport: NormalizeReport = createStubNormalizeReport();

/**
 * Default report reader: reads the bytes at `reportPath`. A missing file
 * (`ENOENT`) is the REPORT_MISSING signal (Req 6.5); other read errors
 * propagate to the caller (mapped to UPLOAD_FAILED).
 */
export const defaultReadReport: ReadReportFn = async (reportPath) => {
  try {
    const bytes = await fsp.readFile(reportPath);
    return { exists: true, bytes };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
    throw err;
  }
};

/**
 * Recursively collect REGULAR files under `dir`. Symlinks are NEVER followed
 * (safety: never traverse a link off the scan target); special files
 * (sockets/fifos/devices) are skipped.
 */
async function collectRegularFiles(dir: string, out: string[]): Promise<void> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue; // never follow links
    if (entry.isDirectory()) {
      await collectRegularFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

/**
 * Default `Source_Snapshot` builder: a gzipped tar (`.tgz`) of the extracted
 * `sourcePath` tree. Read-only and execution-free — it only `fs.readFile`s each
 * regular file's bytes and streams them through `tar-stream` + `node:zlib`
 * gzip. NEVER follows symlinks, NEVER executes content.
 */
export const defaultMakeSourceSnapshot: MakeSnapshotFn = async (sourcePath) => {
  // Enumerate files FIRST so directory-walk errors surface before we wire the
  // streams (avoids a dangling snapshot promise).
  const files: string[] = [];
  await collectRegularFiles(sourcePath, files);
  files.sort(); // deterministic archive ordering

  const pack = createTarPack();
  const gzip = createGzip();
  const chunks: Buffer[] = [];

  const collected = new Promise<Buffer>((resolve, reject) => {
    gzip.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    gzip.on("end", () => resolve(Buffer.concat(chunks)));
    gzip.on("error", reject);
    pack.on("error", reject);
  });

  pack.pipe(gzip);

  try {
    for (const absFile of files) {
      const rel = path.relative(sourcePath, absFile);
      // Read bytes ONLY — never require/import/evaluate fetched content.
      const data = await fsp.readFile(absFile);
      await new Promise<void>((resolve, reject) => {
        pack.entry({ name: rel }, data, (err) => (err ? reject(err) : resolve()));
      });
    }
    pack.finalize();
    return await collected;
  } catch (err) {
    collected.catch(() => undefined); // avoid an unhandled rejection on abort
    pack.destroy();
    gzip.destroy();
    throw err;
  }
};

/** Outcome of the timeout-guarded Storage_Service call. */
type UploadOutcome =
  | { ok: true; scanRecord: ScanRecord }
  | { ok: false; message: string };

/**
 * Race the Storage_Service `uploadScan` against a confirm timeout. A timeout OR
 * a rejection both resolve to `{ ok: false }` so the caller maps them to a
 * single `UPLOAD_FAILED` (Req 6.6). On timeout the underlying upload promise is
 * intentionally NOT awaited and the report is left in place.
 */
async function uploadWithTimeout(
  upload: () => Promise<{ scanRecord: ScanRecord }>,
  timeoutMs: number,
): Promise<UploadOutcome> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<UploadOutcome>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          ok: false,
          message: `Storage_Service did not confirm within ${timeoutMs}ms`,
        }),
      timeoutMs,
    );
  });

  const attempt = upload()
    .then((r): UploadOutcome => ({ ok: true, scanRecord: r.scanRecord }))
    .catch(
      (err: unknown): UploadOutcome => ({
        ok: false,
        message: `Storage_Service reported a failure: ${
          err instanceof Error ? err.message : String(err)
        }`,
      }),
    );

  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Parse raw report bytes into the `unknown` value the normalizer expects. JSON
 * is parsed; non-JSON (HTML/MD) is handed through as the raw string so the
 * normalizer's fail-safe defaults take over (Req 12.5).
 */
function parseRawReport(bytes: Buffer): unknown {
  const text = bytes.toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Run the upload-trigger core (Interface 3, Reqs 6.3–6.6). Resolves to a typed
 * {@link UploadTriggerResult}; never throws across its boundary.
 *
 * Ordering matters for the guards:
 *  1. INVALID_IDENTIFIER (contract identity) — before any I/O.
 *  2. REPORT_MISSING — before any Storage_Service call (Req 6.5).
 *  3. INVALID_RISK_SCORE — surfaced from the normalizer (Req 13.6).
 *  4. Storage upload within the confirm timeout → UPLOAD_FAILED on no-confirm
 *     /failure with the report RETAINED (Req 6.6); success → cleanup +
 *     `{ scanRecord }` (Reqs 6.3, 6.4, 4.7).
 */
export async function runUploadTrigger(
  deps: RunUploadTriggerDeps,
): Promise<UploadTriggerResult> {
  const { contract, cleanup, storageService } = deps;
  const normalizeReport = deps.normalizeReport ?? defaultStubNormalizeReport;
  const readReport = deps.readReport ?? defaultReadReport;
  const makeSnapshot = deps.makeSnapshot ?? defaultMakeSourceSnapshot;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_UPLOAD_CONFIRM_TIMEOUT_MS;

  // 1) INVALID_IDENTIFIER guard (Req 7.6). The contract's identity is
  //    authoritative (resolved by /api/resolve); a successful scan guarantees
  //    these are non-empty (Req 6.1), so an empty value here is a hard reject.
  const packageName = contract.packageName?.trim() ?? "";
  const version = contract.version?.trim() ?? "";
  if (packageName === "" || version === "") {
    return {
      ok: false,
      errorType: UploadErrorType.INVALID_IDENTIFIER,
      message: "Scan_Result_Contract is missing a non-empty packageName or version",
    };
  }

  // 2) REPORT_MISSING guard (Req 6.5): no file at reportPath → do NOT call
  //    the Storage_Service.
  let read: ReadReportResult;
  try {
    read = await readReport(contract.reportPath);
  } catch (err) {
    // The file exists but could not be read (e.g. permissions). Storage was
    // not called; the report is left in place → UPLOAD_FAILED.
    return {
      ok: false,
      errorType: UploadErrorType.UPLOAD_FAILED,
      message: `failed to read report at ${contract.reportPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  if (!read.exists || read.bytes === undefined) {
    return {
      ok: false,
      errorType: UploadErrorType.REPORT_MISSING,
      message: `no Scan_Report found at ${contract.reportPath}`,
    };
  }
  const reportBytes = read.bytes;

  // 3) Normalize → Report_Schema + verdict. A present-but-out-of-range
  //    riskScore is rejected (Req 13.6); an absent one is fail-safe-defaulted.
  const normalized = normalizeReport(parseRawReport(reportBytes));
  if (!normalized.ok) {
    return { ok: false, errorType: normalized.errorType, message: normalized.message };
  }
  // The CONTRACT identity wins over whatever the raw report claimed: PackGuard
  // knows the true resolved name+version, so the Tigris keys + Scan_Record use
  // them (Reqs 7.3, 7.4) and can never be the placeholder.
  const report: ReportSchema = {
    ...normalized.report,
    packageName,
    version,
  };

  // 4) Build the Source_Snapshot (gzipped tar of the extracted source). A
  //    snapshot failure means we never call storage → UPLOAD_FAILED, report
  //    retained.
  let sourceSnapshot: Buffer;
  try {
    sourceSnapshot = await makeSnapshot(contract.sourcePath);
  } catch (err) {
    return {
      ok: false,
      errorType: UploadErrorType.UPLOAD_FAILED,
      message: `failed to build Source_Snapshot from ${contract.sourcePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // 5) Hand off to the Storage_Service within the 30s confirm budget (Req 6.6).
  const outcome = await uploadWithTimeout(
    () => storageService.uploadScan({ report, reportBytes, sourceSnapshot }),
    timeoutMs,
  );
  if (!outcome.ok) {
    // No-confirm-in-30s OR storage failure → UPLOAD_FAILED; RETAIN the report
    // (we deliberately do NOT call cleanup) (Req 6.6).
    return {
      ok: false,
      errorType: UploadErrorType.UPLOAD_FAILED,
      message: outcome.message,
    };
  }

  // 6) Confirmed success (Reqs 6.3, 6.4): clean up the retained scan-target
  //    (Req 4.7). Cleanup is best-effort — a confirmed upload must not be
  //    reported as failed just because directory removal hiccuped.
  try {
    await cleanup();
  } catch {
    // best-effort; the scan record is already persisted.
  }

  return { ok: true, scanRecord: outcome.scanRecord };
}

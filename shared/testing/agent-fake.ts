/**
 * Fake `Local_Fetcher_Agent` response helpers.
 *
 * Factory functions that produce sample *successful* responses for the two
 * loopback-agent endpoints from design.md → "Interface 2" / "Interface 3":
 *
 *  - `POST /local/fetch`  → {@link ScanResultContract}
 *  - `POST /local/upload` → `{ scanRecord: ScanRecord }`
 *
 * These let Person B's UI (tasks 14/15) and Person A's upload trigger
 * (task 7.2) build against the agreed shapes before the real agent
 * (tasks 6/7) exists. They are fakes/fixtures only — no HTTP, no filesystem.
 */

import type { ScanResultContract, ScanRecord } from "../scan.js";
import type { ReportSchema } from "../report.js";
import { CONFIG_DEFAULTS } from "../config.js";
import { reportKeyFor, sourceKeyFor } from "./storage-fake.js";

/** Overridable fields for a fake fetch (Scan_Result_Contract) response. */
export interface FakeFetchOptions {
  packageName?: string;
  version?: string;
  /** Absolute path to the extracted source root (`./scan-target/`). */
  sourcePath?: string;
  /** Absolute path where the Operator's report is expected. */
  reportPath?: string;
}

/**
 * Build a sample successful {@link ScanResultContract} — the value the agent
 * returns from `POST /local/fetch` after a successful extraction (Req 6.1).
 * All four fields are non-empty and `reportPath` sits inside `sourcePath`
 * (Property 8 / Reqs 6.1, 6.2).
 */
export function makeFakeScanResultContract(
  options: FakeFetchOptions = {},
): ScanResultContract {
  const packageName = options.packageName ?? "left-pad";
  const version = options.version ?? "1.3.0";
  const sourcePath =
    options.sourcePath ?? `/tmp/packguard/${CONFIG_DEFAULTS.SCAN_TARGET_DIR}`;
  const reportPath = options.reportPath ?? `${sourcePath}/.packguard/report.json`;

  return { packageName, version, sourcePath, reportPath };
}

/** Overridable fields for a fake upload response. */
export interface FakeUploadOptions {
  packageName?: string;
  version?: string;
  verdict?: ScanRecord["verdict"];
  riskScore?: number;
  thresholdUsed?: number;
  /** Set to `null` to exercise the missing-public-URL fallback (Req 8.2). */
  publicReportUrl?: string | null;
  createdAt?: string;
}

/**
 * Build a sample successful upload response — the value the agent returns
 * from `POST /local/upload` once storage confirms (Interface 3, Req 6.4).
 * The embedded {@link ScanRecord} is complete with a UTC ISO `createdAt`
 * (Property 15 / Reqs 7.5, 8.5).
 */
export function makeFakeUploadResponse(
  options: FakeUploadOptions = {},
): { scanRecord: ScanRecord } {
  const packageName = options.packageName ?? "left-pad";
  const version = options.version ?? "1.3.0";
  const verdict = options.verdict ?? "SAFE";
  const riskScore = options.riskScore ?? 12;
  const thresholdUsed = options.thresholdUsed ?? CONFIG_DEFAULTS.RISK_THRESHOLD;
  const reportKey = reportKeyFor(packageName, version);
  const sourceKey = sourceKeyFor(packageName, version);
  const publicReportUrl =
    options.publicReportUrl === undefined
      ? `${CONFIG_DEFAULTS.TIGRIS_ENDPOINT}/${CONFIG_DEFAULTS.TIGRIS_BUCKET}/${reportKey}`
      : options.publicReportUrl;

  const scanRecord: ScanRecord = {
    packageName,
    version,
    verdict,
    riskScore,
    thresholdUsed,
    publicReportUrl,
    reportKey,
    sourceKey,
    createdAt: options.createdAt ?? "2024-01-01T00:00:00.000Z",
  };

  return { scanRecord };
}

/**
 * Build a normalized {@link ReportSchema} that is consistent with a fake
 * upload response, handy for wiring the upload trigger's
 * `report → storage.uploadScan` path in tests. Defaults to a SAFE report.
 */
export function makeFakeNormalizedReport(
  options: FakeUploadOptions = {},
): ReportSchema {
  const packageName = options.packageName ?? "left-pad";
  const version = options.version ?? "1.3.0";
  const verdict = options.verdict ?? "SAFE";
  const riskScore = options.riskScore ?? 12;

  return {
    packageName,
    version,
    verdict,
    riskScore,
    findings: [],
  };
}

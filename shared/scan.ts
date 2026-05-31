/**
 * Shared scan contracts: the Person A → Person B handshake
 * (Scan_Result_Contract), the persisted Scan_Record, the gallery list result,
 * and Person A's internal resolution / safe-tar models.
 *
 * See design.md → "Components and Interfaces" (Interfaces 1 & 5) and
 * "Data Models" (Scan_Record, Resolution & internal fetch models).
 */

import type { Verdict } from "./report.js";

/**
 * Interface 1 — Scan_Result_Contract (Person A → Person B), Req 6.1.
 *
 * Produced by the Local_Fetcher_Agent after successful extraction. It tells
 * Person B where the report will land and what was scanned. All four fields
 * MUST be non-empty when extraction succeeds (Req 6.1).
 */
export interface ScanResultContract {
  /** Resolved package; non-empty; supports `@scope/name` (Req 6.1). */
  packageName: string;
  /** Exact resolved version; non-empty (Req 6.1). */
  version: string;
  /** Absolute local path to `./scan-target/` (the extracted source) (Req 6.1). */
  sourcePath: string;
  /**
   * Absolute local path where the Operator's Scan_Report is expected
   * (e.g. `./scan-target/.packguard/report.json`). Pre-computed so the
   * upload trigger knows where to look (Reqs 6.1, 6.2).
   */
  reportPath: string;
}

/**
 * Scan_Record persisted in Tigris (design.md → "Data Models → Scan_Record",
 * Req 7.5). Stored as JSON at `records/{encodedName}/{version}.json`. The
 * gallery lists these objects (Req 9); each scanned version gets its own
 * record (Req 9.3).
 */
export interface ScanRecord {
  /** Package name. 1..214 chars (Req 7.5). */
  packageName: string;
  /** Version. 1..256 chars (Req 7.5). */
  version: string;
  /** Verdict frozen at record creation time (Req 13.5). */
  verdict: Verdict;
  /** Integer risk score, 0..100 (Req 7.5). */
  riskScore: number;
  /** The threshold T applied when this record was created (Req 13.5). */
  thresholdUsed: number;
  /** Public report URL, or null if URL generation failed (Reqs 8.2, 11.8). */
  publicReportUrl: string | null;
  /** Tigris key: `reports/{encodedName}/{version}/report.json` (Req 7.3). */
  reportKey: string;
  /** Tigris key: `sources/{encodedName}/{version}/source.tgz` (Req 7.4). */
  sourceKey: string;
  /** UTC ISO-8601 creation timestamp (Reqs 7.5, 8.5). */
  createdAt: string;
}

/**
 * Interface 5 — Gallery / List result (Person B), Req 9.1.
 *
 * Semantics (design.md → "Interface 5"):
 *  - Empty store → `{ records: [], partial: false, unavailable: false }` (Req 9.6).
 *  - Some records fail to load → return the rest with `partial: true` (Req 9.4).
 *  - Store unreachable → `unavailable: true`, no partial data (Req 9.8).
 */
export interface GalleryResult {
  /** Up to 100 records (Req 9.1); one per scanned version (Req 9.3). */
  records: ScanRecord[];
  /** True if some records could not be retrieved (Req 9.4). */
  partial: boolean;
  /** True only when the data store is fully unavailable (Req 9.8). */
  unavailable: boolean;
}

/**
 * Resolution output of `/api/resolve` (design.md → "Resolution & internal
 * fetch models", Person A internal). Latest if unspecified (Req 1.2), else
 * the exact requested version (Req 1.3).
 */
export interface ResolvedPackage {
  /** Resolved package name (supports `@scope/name`). */
  packageName: string;
  /** Resolved version: latest if unspecified (Req 1.2), else exact (Req 1.3). */
  version: string;
  /** Tarball URL from npm metadata. */
  tarballUrl: string;
  /** Optional shasum/integrity from npm metadata. */
  integrity?: string;
}

/**
 * Safe-tar limits enforced by the Extractor (Reqs 2.4, 3.8). Numeric `number`
 * field types (rather than literal types) so the same shape can describe both
 * the default constant and any test/override limits.
 */
export interface SafeTarLimits {
  /** Compressed download cap: 100 MB (Req 2.4). */
  maxTarballBytes: number;
  /** Total uncompressed cap: 250 MB (Req 3.8). */
  maxUncompressedBytes: number;
  /** Entry-count cap: 10,000 (Req 3.8). */
  maxEntryCount: number;
}

/**
 * Default safe-tar limits with the exact values from design.md → "Resolution
 * & internal fetch models" (Reqs 2.4, 3.8). Frozen via `as const` so the
 * values cannot drift at runtime.
 */
export const DEFAULT_SAFE_TAR_LIMITS: SafeTarLimits = {
  maxTarballBytes: 100_000_000, // 100 MB compressed download cap (Req 2.4)
  maxUncompressedBytes: 250_000_000, // 250 MB total uncompressed (Req 3.8)
  maxEntryCount: 10_000, // entry-count cap (Req 3.8)
} as const;

/**
 * Scan_Result_Contract construction (Person A, task 6.3).
 *
 * Produces the Person A → Person B handshake ({@link ScanResultContract},
 * design.md → "Interface 1") after a successful safe extraction. The contract
 * tells Person B *what* was scanned (`packageName`, `version`), *where* the
 * extracted source lives (`sourcePath`), and *where* the Operator's report is
 * expected to land (`reportPath`) so the upload trigger (task 7.2) knows where
 * to look.
 *
 * Requirement mapping:
 *  - Req 6.1: on successful extraction, emit NON-EMPTY `packageName`,
 *    `version`, `sourcePath`, and `reportPath`.
 *  - Req 6.2: `reportPath` is the file location where the Operator's
 *    Scan_Report is expected to be written.
 *  - Property 8: `reportPath` is a path INSIDE the `Scan_Target_Directory`.
 *
 * ── reportPath layout ────────────────────────────────────────────────────
 * We pre-compute `reportPath` as `<scanTarget>/.packguard/report.json` (the
 * exact example from design.md → Interface 1). Placing it under a `.packguard`
 * subdirectory keeps PackGuard's own metadata out of the way of the scanned
 * package's files while remaining strictly *inside* the scan target so the
 * containment guarantee (Property 8 / Req 6.2) holds. We create the
 * `.packguard` directory so the Operator / Opsera can write the report there,
 * but we DO NOT create or require the report file itself — it is the Operator's
 * manual scan that produces it.
 *
 * This module performs no network or execution; it only computes paths and
 * (optionally) creates an empty metadata directory. It NEVER reads, requires,
 * imports, evaluates, or executes any fetched package content.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";

import type { ScanResultContract } from "@shared/scan";

/** The PackGuard metadata subdirectory inside the scan target. */
export const PACKGUARD_DIR_NAME = ".packguard";

/** The report filename the Operator's Scan_Report is expected to be written as. */
export const REPORT_FILE_NAME = "report.json";

/**
 * Compute the absolute `reportPath` for a given scan-target root.
 *
 * The result is always `<scanTargetRoot>/.packguard/report.json`, resolved to
 * an absolute path. Exported so the upload trigger (task 7.2) and tests can
 * reuse the exact same computation rather than re-deriving the location — there
 * is a single source of truth for where the report lands (Req 6.2).
 *
 * Containment (Property 8): because both segments are plain, non-traversing
 * names joined onto the root, the returned path is always a descendant of
 * `scanTargetRoot`. {@link isReportPathContained} can assert this for callers
 * that want a runtime guarantee.
 */
export function computeReportPath(scanTargetRoot: string): string {
  return path.resolve(scanTargetRoot, PACKGUARD_DIR_NAME, REPORT_FILE_NAME);
}

/**
 * Compute the absolute path to the `.packguard` metadata directory for a given
 * scan-target root. This is the parent directory of {@link computeReportPath}.
 */
export function computePackguardDir(scanTargetRoot: string): string {
  return path.resolve(scanTargetRoot, PACKGUARD_DIR_NAME);
}

/**
 * `true` iff `reportPath` resolves to a location equal to or a descendant of
 * `scanTargetRoot` (Property 8 / Req 6.2). Uses the same lexical containment
 * rule as the Extractor so the two agree on what "inside the scan target"
 * means.
 */
export function isReportPathContained(
  reportPath: string,
  scanTargetRoot: string,
): boolean {
  const resolvedRoot = path.resolve(scanTargetRoot);
  const resolvedReport = path.resolve(reportPath);
  return (
    resolvedReport === resolvedRoot ||
    resolvedReport.startsWith(resolvedRoot + path.sep)
  );
}

/**
 * Ensure the `.packguard` directory exists inside the scan target so the
 * Operator / Opsera can write the report there. Creates only the directory —
 * NEVER the report file (Req 6.2: PackGuard pre-computes the location; the
 * Operator produces the file). Idempotent (`recursive: true`).
 */
export async function ensureReportDir(scanTargetRoot: string): Promise<void> {
  await fsp.mkdir(computePackguardDir(scanTargetRoot), { recursive: true });
}

/** Inputs needed to build a {@link ScanResultContract}. */
export interface BuildScanResultContractInput {
  /** Resolved package name; must be non-empty (Req 6.1). */
  packageName: string;
  /** Resolved exact version; must be non-empty (Req 6.1). */
  version: string;
  /**
   * The scan-target root — the Extractor's `canonicalRoot` (the realpath of
   * `./scan-target/`). Becomes `sourcePath` and the base for `reportPath`.
   */
  scanTargetRoot: string;
}

/**
 * Build the {@link ScanResultContract} for a successful scan (Reqs 6.1, 6.2).
 *
 *  - `sourcePath` = the absolute scan-target root (the extractor's
 *    `canonicalRoot`).
 *  - `reportPath` = `<scanTargetRoot>/.packguard/report.json`, guaranteed
 *    inside the scan target (Property 8).
 *
 * Throws if `packageName` or `version` is empty, because Req 6.1 mandates all
 * four fields be non-empty on success — an empty identifier is a programming
 * error upstream (the resolver guarantees non-empty values) and must never be
 * silently emitted as a "successful" contract.
 */
export function buildScanResultContract(
  input: BuildScanResultContractInput,
): ScanResultContract {
  const packageName = input.packageName.trim();
  const version = input.version.trim();
  if (packageName === "") {
    throw new Error("cannot build Scan_Result_Contract: packageName is empty (Req 6.1)");
  }
  if (version === "") {
    throw new Error("cannot build Scan_Result_Contract: version is empty (Req 6.1)");
  }

  const sourcePath = path.resolve(input.scanTargetRoot);
  const reportPath = computeReportPath(sourcePath);

  return { packageName, version, sourcePath, reportPath };
}

/**
 * No-exec fetch + extract pipeline (Person A, tasks 5.1 + 6.3).
 *
 * Composes the existing Person A building blocks into the single "inspect
 * without installing" pipeline that the `Local_Fetcher_Agent` (`POST
 * /local/fetch`, task 7.1) drives:
 *
 *     download tarball bytes  →  wrap as a Readable  →  safe-tar extract
 *                             →  build Scan_Result_Contract
 *
 * It deliberately stops BEFORE launching VS Code: the launcher wiring belongs
 * to task 7.1. This module's job (task 5.1) is the safe fetch+extract, and
 * (task 6.3) producing the {@link ScanResultContract} on success.
 *
 * ── CORE SAFETY GUARANTEE: never execute fetched content ──────────────────
 * This is the heart of Property 1 / Requirement 3. The pipeline:
 *   - NEVER runs an install command (`npm install`/`ci`, `yarn`, `pnpm`, …) —
 *     it never invokes a package manager at all (Reqs 3.2, 3.4). The only
 *     child-process spawn in the whole Person A flow is `code` in the launcher,
 *     which is wired LATER (task 7.1) and operates on the directory, not on
 *     fetched files.
 *   - NEVER `require()`s, dynamic-`import()`s, `eval`s, or `vm`-runs any
 *     extracted path (Reqs 3.3). Tarball bytes flow: network → Buffer →
 *     Readable → tar-stream → `fs.write`. They are only ever written to disk as
 *     INERT DATA and read back as bytes; no fetched path is loaded as a module
 *     or evaluated as code.
 *   - IGNORES lifecycle scripts (`preinstall`/`install`/`postinstall`): nothing
 *     here parses `package.json` "scripts" or executes them (Req 3.4).
 *   - Treats ALL extracted content as untrusted read-only data (Req 3.5).
 * These guarantees are intrinsic to the data flow below — there is no code path
 * that hands a fetched file to an executor. Task 5.2's property test pins this
 * by spying on `child_process`, `require`, dynamic `import`, `eval`, and `vm`.
 *
 * ── Failure handling (Reqs 2.3, 2.4, 3.6, 3.7, 3.8, 4.2–4.5) ──────────────
 * The pipeline NEVER throws across its boundary; it returns a typed
 * {@link FetchAndExtractResult} discriminated union carrying a
 * {@link FetchErrorType}. On ANY failure no package content is executed
 * (Reqs 3.3, 3.7):
 *   - download failure → `DOWNLOAD_FAILED` / `DOWNLOAD_TOO_LARGE` (from
 *     {@link downloadTarball}); nothing was extracted, so there is nothing to
 *     clean up beyond discarded bytes.
 *   - extraction failure → the Extractor's distinct typed violation
 *     (`PATH_TRAVERSAL` / `ABSOLUTE_PATH` / `LINK_TARGET_ESCAPE` /
 *     `RESOURCE_LIMIT_EXCEEDED` / `EXTRACTION_TIMEOUT`). The Extractor already
 *     rolls back all written paths AND removes the whole scan-target on abort
 *     (Reqs 4.2–4.7), so cleanup happens WITHOUT executing content.
 *
 * ── Success-retention vs. cleanup seam (Reqs 4.7, 5.1) ────────────────────
 * On SUCCESS the scan-target is RETAINED (we pass `removeTargetOnSuccess:
 * false` to the Extractor, its default). The launcher/operator need the
 * populated directory to run the manual Opsera scan and the upload trigger
 * against it. This pipeline therefore does NOT remove the directory on success;
 * instead it exposes {@link FetchAndExtractSuccess.cleanup} — a bound helper
 * the caller invokes (in its own `finally`) once the whole
 * launch → manual scan → upload lifecycle completes, which is the point at
 * which Req 4.7's "extraction for a package completes" truly holds. This reuses
 * the Extractor's documented {@link cleanupScanTarget} seam.
 *
 * ── Injectability (testing / property tests) ──────────────────────────────
 * The download `fetchFn`, resource `limits`, and the download/extraction
 * `timeoutMs` budgets are all injectable so tests and property tests can drive
 * the pipeline with a fake fetch returning an in-memory `.tgz` — no real
 * network required.
 */

import {
  downloadTarball,
  tarballBytesToReadable,
  type FetchFn,
} from "./download.js";
import {
  cleanupScanTarget,
  safeExtract,
  type ExtractorErrorType,
} from "./extractor.js";
import { buildScanResultContract, ensureReportDir } from "./scan-result.js";

import type { DownloadErrorType } from "./download.js";
import type { ResolvedPackage, SafeTarLimits, ScanResultContract } from "@shared/scan";
import { DEFAULT_SAFE_TAR_LIMITS } from "@shared/scan";

/**
 * The subset of {@link FetchErrorType} this pipeline can surface: the
 * download failures plus the extractor's distinct violation types. (Resolution
 * errors are produced upstream by `/api/resolve`; launch errors are produced
 * downstream by the launcher in task 7.1.)
 */
export type FetchAndExtractErrorType = DownloadErrorType | ExtractorErrorType;

/** Options for {@link fetchAndExtract}. All deps are injectable for tests. */
export interface FetchAndExtractOptions {
  /** Isolated extraction root (`./scan-target/`). Required. */
  scanTargetDir: string;
  /** Injectable fetch for the download step (default: global `fetch`). */
  fetchFn?: FetchFn;
  /** Resource limits (Reqs 2.4, 3.8). Defaults to {@link DEFAULT_SAFE_TAR_LIMITS}. */
  limits?: SafeTarLimits;
  /** Download timeout in ms (Req 2.1). Defaults to the download module's 30s. */
  downloadTimeoutMs?: number;
  /** Extraction timeout in ms (Req 3.7). Defaults to the extractor's 30s. */
  extractionTimeoutMs?: number;
  /** Optional external abort signal forwarded to the download step. */
  signal?: AbortSignal;
  /**
   * Strict-algorithm escape hatch: remove the scan-target on SUCCESS too.
   * Defaults to `false` — see the "success-retention vs. cleanup seam" note.
   * On abort the directory is always removed regardless of this flag.
   */
  removeTargetOnSuccess?: boolean;
}

/** Successful fetch+extract outcome carrying the Scan_Result_Contract (task 6.3). */
export interface FetchAndExtractSuccess {
  ok: true;
  /** Non-empty `packageName`, `version`, `sourcePath`, `reportPath` (Req 6.1). */
  contract: ScanResultContract;
  /** Canonical (realpath-resolved) extraction root from the Extractor. */
  canonicalRoot: string;
  /** Number of tar entries processed. */
  entryCount: number;
  /** Cumulative uncompressed bytes written. */
  totalUncompressed: number;
  /**
   * Bound cleanup helper that removes the retained scan-target (Req 4.7). The
   * caller (task 7.1 agent / upload trigger) invokes this in its own `finally`
   * once the launch → manual scan → upload lifecycle completes. Idempotent and
   * safe to call more than once. NEVER executes any package content — it only
   * removes files.
   */
  cleanup: () => Promise<void>;
}

/** Aborted fetch+extract outcome with a distinct typed error. */
export interface FetchAndExtractFailure {
  ok: false;
  errorType: FetchAndExtractErrorType;
  message: string;
}

/**
 * Discriminated result of {@link fetchAndExtract}. The pipeline NEVER throws
 * across its boundary and NEVER executes package content on any path.
 */
export type FetchAndExtractResult = FetchAndExtractSuccess | FetchAndExtractFailure;

/**
 * Run the no-exec fetch + extract pipeline for an already-resolved package and
 * produce the {@link ScanResultContract} on success.
 *
 * Resolution is `/api/resolve`'s job per the design topology, so the canonical
 * entry point takes a {@link ResolvedPackage}. (A convenience that resolves
 * first is offered separately as {@link resolveFetchAndExtract}.)
 *
 * Steps:
 *  1. Download the `.tgz` bytes from `resolved.tarballUrl` with the size cap
 *     and timeout (Reqs 2.1–2.4). On failure → typed download error; nothing
 *     extracted.
 *  2. Wrap the bytes as a `Readable` and safe-extract into `scanTargetDir`
 *     (Reqs 3, 4). On abort the Extractor rolls back + removes the directory;
 *     we surface its distinct violation type.
 *  3. On success, create the `.packguard` report directory (NOT the report
 *     file) and build the contract (Reqs 6.1, 6.2). Retain the directory and
 *     hand back a `cleanup` seam.
 *
 * SAFETY: at no point is a fetched file required/imported/evaluated/spawned.
 */
export async function fetchAndExtract(
  resolved: ResolvedPackage,
  options: FetchAndExtractOptions,
): Promise<FetchAndExtractResult> {
  const limits = options.limits ?? DEFAULT_SAFE_TAR_LIMITS;
  const { scanTargetDir } = options;

  // 1) Download the tarball bytes (inert; never executed). Reqs 2.1–2.4.
  const downloaded = await downloadTarball(resolved.tarballUrl, {
    fetchFn: options.fetchFn,
    limits,
    ...(options.downloadTimeoutMs !== undefined
      ? { timeoutMs: options.downloadTimeoutMs }
      : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  if (!downloaded.ok) {
    // DOWNLOAD_FAILED / DOWNLOAD_TOO_LARGE. No extraction occurred and partial
    // bytes are discarded by the download module — no content was executed.
    return { ok: false, errorType: downloaded.errorType, message: downloaded.message };
  }

  // 2) Wrap bytes as a stream and safely extract. The bytes only ever become
  //    a tar-stream and then `fs.write` calls — never a module or eval input.
  const tgzStream = tarballBytesToReadable(downloaded.bytes);
  const extracted = await safeExtract(tgzStream, scanTargetDir, {
    limits,
    ...(options.extractionTimeoutMs !== undefined
      ? { timeoutMs: options.extractionTimeoutMs }
      : {}),
    // Default false: retain on success for the launcher (see seam note).
    removeTargetOnSuccess: options.removeTargetOnSuccess ?? false,
  });
  if (!extracted.ok) {
    // The Extractor already rolled back all written paths AND removed the
    // scan-target on abort (Reqs 4.2–4.7) — cleanup happened WITHOUT executing
    // any content. Surface its distinct violation type unchanged (Req 3.7).
    return { ok: false, errorType: extracted.errorType, message: extracted.message };
  }

  // 3) Success (task 6.3): pre-create the report directory (NOT the file) and
  //    build the Scan_Result_Contract. `canonicalRoot` is the resolved
  //    scan-target, so it is `sourcePath`; `reportPath` lives inside it.
  const { canonicalRoot, entryCount, totalUncompressed } = extracted;
  await ensureReportDir(canonicalRoot);
  const contract = buildScanResultContract({
    packageName: resolved.packageName,
    version: resolved.version,
    scanTargetRoot: canonicalRoot,
  });

  return {
    ok: true,
    contract,
    canonicalRoot,
    entryCount,
    totalUncompressed,
    // Retain-vs-cleanup seam: the caller removes the scan-target later via this
    // bound helper (Req 4.7). Removing files only — never executes content.
    cleanup: () => cleanupScanTarget(canonicalRoot),
  };
}

/**
 * Convenience that resolves a package FIRST and then runs {@link fetchAndExtract}.
 *
 * Resolution is normally `/api/resolve`'s responsibility (design topology), so
 * this is offered only for local/standalone use (e.g. the agent running the
 * whole flow on one machine). The resolver is injected via `resolveFn` so this
 * stays network-free in tests; failures from resolution are surfaced as typed
 * results unchanged.
 *
 * This wrapper is intentionally thin and adds NO new execution surface — it
 * only forwards a resolved package into the same safe pipeline.
 */
export async function resolveFetchAndExtract(
  resolveFn: () => Promise<
    { ok: true; resolved: ResolvedPackage } | { ok: false; errorType: string; message: string }
  >,
  options: FetchAndExtractOptions,
): Promise<FetchAndExtractResult | { ok: false; errorType: string; message: string }> {
  const resolution = await resolveFn();
  if (!resolution.ok) {
    return resolution;
  }
  return fetchAndExtract(resolution.resolved, options);
}

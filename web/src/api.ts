/* ============================================================
 * api.ts — typed client for every backend endpoint (§4).
 * ------------------------------------------------------------
 * AbortController-based client timeouts (10s resolve, 30s overall flow) and
 * typed ApiError handling. Two modes:
 *
 *   USE_MOCK = true   → in-browser simulation (fixtures from mock/data.ts)
 *   USE_MOCK = false  → real fetch() to same-origin /api/* and the local agent
 *                       at http://127.0.0.1:3939
 *
 * Mode is chosen by the `VITE_USE_MOCK` env var (defaults to mock in dev, real
 * in production builds), so flipping it wires straight into the backend with
 * zero code change. The function bodies for both modes use the exact contract
 * shapes from `@shared/contracts`.
 * ============================================================ */
import type {
  GalleryResult,
  ReportSchema,
  ResolvedPackage,
  ScanRecord,
} from "@shared/contracts";
import { errorCopy, FRAMING } from "./framing";
import {
  ERROR_TRIGGERS,
  GALLERY_SEED,
  recordFor,
  REPORTS,
  resolved,
} from "./mock/data";

// --- mode + endpoints --------------------------------------------------------
const env = import.meta.env as Record<string, string | undefined>;
/** Mock unless explicitly disabled; production builds default to the real API. */
export const USE_MOCK = env.VITE_USE_MOCK
  ? env.VITE_USE_MOCK !== "false"
  : import.meta.env.DEV;

/** Local loopback agent base URL (overridable for unusual setups). */
export const AGENT = env.VITE_AGENT_URL || "http://127.0.0.1:3939";

export const T_RESOLVE = 10_000; // §6: abort /api/resolve at 10s
export const T_FLOW = 30_000; // §6: abort overall flow at 30s

// --- runtime demo overrides (driven by the Tweaks panel in mock mode) --------
export interface MockOverrides {
  /** "ok" | "no-code" | "down" — simulates the local agent health. */
  agent: "ok" | "no-code" | "down";
  /** "ok" | "partial" | "empty" | "unavailable" — simulates the gallery. */
  gallery: "ok" | "partial" | "empty" | "unavailable";
  /** Force POST /local/upload to report REPORT_MISSING. */
  forceReportMissing: boolean;
}

export const mockOverrides: MockOverrides = {
  agent: "ok",
  gallery: "ok",
  forceReportMissing: false,
};

// --- ApiError ----------------------------------------------------------------
/** Carries the contract errorType string + message (+ manualCommand on VSCODE_* failures). */
export class ApiError extends Error {
  errorType: string;
  manualCommand?: string;
  aborted?: boolean;
  readonly isApiError = true;

  constructor(errorType: string, message?: string, manualCommand?: string) {
    super(message || errorType);
    this.name = "ApiError";
    this.errorType = errorType;
    if (manualCommand) this.manualCommand = manualCommand;
  }
}

function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError || (!!e && (e as ApiError).isApiError === true);
}

/** Wrap an arbitrary thrown value into an ApiError shape. */
function toApiError(err: unknown, fallbackType: string, fallbackMsg?: string): ApiError {
  if (isApiError(err)) return err;
  if (err instanceof Error && err.name === "AbortError") {
    const e = new ApiError(fallbackType || "TIMEOUT", fallbackMsg || "Request timed out.");
    e.aborted = true;
    return e;
  }
  const msg = (err instanceof Error && err.message) || fallbackMsg || "Network error.";
  return new ApiError(fallbackType || "NETWORK", msg);
}

export function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === "AbortError") return true;
  return isApiError(err) && err.aborted === true;
}

// --- fetch with timeout + external abort ------------------------------------
async function fetchT(
  url: string,
  opts: RequestInit,
  ms: number,
  externalSignal?: AbortSignal,
): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  if (externalSignal) {
    if (externalSignal.aborted) ctrl.abort();
    else externalSignal.addEventListener("abort", () => ctrl.abort());
  }
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const txt = await res.text();
    const body = txt ? JSON.parse(txt) : {};
    if (!res.ok) {
      throw new ApiError(body.errorType || "HTTP_" + res.status, body.message, body.manualCommand);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

// --- mock helpers ------------------------------------------------------------
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(t);
        const e = new Error("Aborted");
        e.name = "AbortError";
        reject(e);
      });
    }
  });
}

function isScoped(n: string): boolean {
  return /^@[a-z0-9-~][a-z0-9-._~]*\/[a-z0-9-~][a-z0-9-._~]*$/.test(n);
}
function isValidName(n: string): boolean {
  if (!n || n.length > 214) return false;
  if (n.trim() !== n) return false;
  if (isScoped(n)) return true;
  return /^[a-z0-9-~][a-z0-9-._~]*$/.test(n);
}

function mockSourcePath(name: string): string {
  const slug = name.replace("/", "-").replace("@", "");
  return "/Users/operator/.packguard/scan-target/" + slug;
}

// ============================================================================
// §4 — Serverless (same origin)
// ============================================================================

/** POST /api/resolve → ResolvedPackage (10s timeout). */
export async function resolvePackage(
  packageName: string,
  signal?: AbortSignal,
): Promise<ResolvedPackage> {
  if (!USE_MOCK) {
    try {
      return await fetchT(
        "/api/resolve",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ packageName }),
        },
        T_RESOLVE,
        signal,
      );
    } catch (e) {
      throw toApiError(e, "REGISTRY_UNAVAILABLE", FRAMING.scanningUnavailable);
    }
  }
  // --- mock ---
  await delay(620, signal);
  const trig = ERROR_TRIGGERS[packageName];
  if (trig === "INVALID_PACKAGE_NAME" || !isValidName(packageName)) {
    throw new ApiError("INVALID_PACKAGE_NAME", errorCopy("INVALID_PACKAGE_NAME"));
  }
  if (trig === "REGISTRY_UNAVAILABLE") {
    throw new ApiError("REGISTRY_UNAVAILABLE", errorCopy("REGISTRY_UNAVAILABLE"));
  }
  if (trig === "PACKAGE_UNRESOLVED" || !REPORTS[packageName]) {
    throw new ApiError("PACKAGE_UNRESOLVED", errorCopy("PACKAGE_UNRESOLVED"));
  }
  return resolved(packageName);
}

/** GET /api/scans → GalleryResult. */
export async function getScans(signal?: AbortSignal): Promise<GalleryResult> {
  if (!USE_MOCK) {
    try {
      return await fetchT("/api/scans", { method: "GET" }, T_RESOLVE, signal);
    } catch {
      return { records: [], partial: false, unavailable: true };
    }
  }
  // --- mock ---
  await delay(500, signal);
  const mode = mockOverrides.gallery;
  if (mode === "empty") return { records: [], partial: false, unavailable: false };
  if (mode === "unavailable") return { records: [], partial: false, unavailable: true };
  return {
    records: GALLERY_SEED.slice(),
    partial: mode === "partial",
    unavailable: false,
  };
}

// ============================================================================
// §4 — Agentic scan (Daytona → Opsera → Tigris), one call, no human step.
// ============================================================================

export interface AgenticScanResult {
  scanRecord: ScanRecord;
  report: ReportSchema | null;
  steps: { phase: string; message: string }[];
}

/**
 * POST /api/scan → runs the full agentic pipeline server-side:
 *   Daytona isolated sandbox fetch+scan → Opsera static analysis → Tigris.
 * Long-running (~60–120s); we allow up to 5 minutes.
 */
export async function scanPackage(
  packageName: string,
  signal?: AbortSignal,
): Promise<AgenticScanResult> {
  if (!USE_MOCK) {
    try {
      const b = await fetchT(
        "/api/scan",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ packageName }),
        },
        300_000,
        signal,
      );
      return { scanRecord: b.scanRecord, report: b.report ?? null, steps: b.steps ?? [] };
    } catch (e) {
      throw toApiError(e, "SCAN_FAILED", "The agentic scan failed.");
    }
  }
  // --- mock ---
  await delay(1800, signal);
  const trig = ERROR_TRIGGERS[packageName];
  if (trig === "INVALID_PACKAGE_NAME" || !isValidName(packageName)) {
    throw new ApiError("INVALID_PACKAGE_NAME", errorCopy("INVALID_PACKAGE_NAME"));
  }
  const record = recordFor(packageName, {});
  const r = REPORTS[packageName];
  const report = r
    ? { packageName: r.packageName, version: record.version || r.version, verdict: r.verdict, riskScore: r.riskScore, findings: r.findings.slice() }
    : null;
  return { scanRecord: record, report, steps: [] };
}

// ============================================================================
// §4 — Local loopback agent (http://127.0.0.1:3939)
// ============================================================================

export interface AgentHealth {
  reachable: boolean | undefined;
  status: string;
  codeCliAvailable: boolean;
}

/** GET /api/scans (cheap reachability ping) → agentic backend status. */
export async function getHealth(signal?: AbortSignal): Promise<AgentHealth> {
  if (!USE_MOCK) {
    try {
      await fetchT("/api/scans", { method: "GET" }, 8000, signal);
      // Backend + Tigris reachable. There is no local CLI in the agentic flow.
      return { reachable: true, status: "ok", codeCliAvailable: true };
    } catch {
      return { reachable: false, status: "down", codeCliAvailable: false };
    }
  }
  // --- mock ---
  await delay(700, signal);
  const s = mockOverrides.agent;
  if (s === "down") return { reachable: false, status: "down", codeCliAvailable: false };
  return { reachable: true, status: "ok", codeCliAvailable: s !== "no-code" };
}

/** POST /local/fetch → ScanResultContract (any FetchErrorType). */
export async function fetchAndLaunch(
  resolvedPkg: ResolvedPackage,
  signal?: AbortSignal,
): Promise<import("@shared/contracts").ScanResultContract> {
  if (!USE_MOCK) {
    try {
      return await fetchT(
        AGENT + "/local/fetch",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            packageName: resolvedPkg.packageName,
            version: resolvedPkg.version,
            tarballUrl: resolvedPkg.tarballUrl,
            integrity: resolvedPkg.integrity,
          }),
        },
        T_FLOW,
        signal,
      );
    } catch (e) {
      throw toApiError(e, "DOWNLOAD_FAILED", errorCopy("DOWNLOAD_FAILED"));
    }
  }
  // --- mock ---
  await delay(1500, signal);
  const name = resolvedPkg.packageName;
  const trig = ERROR_TRIGGERS[name];
  if (trig === "DOWNLOAD_TOO_LARGE")
    throw new ApiError("DOWNLOAD_TOO_LARGE", errorCopy("DOWNLOAD_TOO_LARGE"));
  if (trig === "LINK_TARGET_ESCAPE")
    throw new ApiError("LINK_TARGET_ESCAPE", errorCopy("LINK_TARGET_ESCAPE"));
  if (trig === "VSCODE_UNAVAILABLE") {
    const cmd = 'code "' + mockSourcePath(name) + '"';
    throw new ApiError("VSCODE_UNAVAILABLE", errorCopy("VSCODE_UNAVAILABLE"), cmd);
  }
  return {
    packageName: name,
    version: resolvedPkg.version,
    sourcePath: mockSourcePath(name),
    reportPath: mockSourcePath(name) + "/.packguard/report.json",
  };
}

/** POST /local/upload → { scanRecord } (any UploadErrorType). */
export async function uploadReport(
  packageName: string,
  version: string,
  signal?: AbortSignal,
): Promise<ScanRecord> {
  const uploadId = packageName + "@" + version;
  if (!USE_MOCK) {
    try {
      const b = await fetchT(
        AGENT + "/local/upload",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uploadId }),
        },
        T_FLOW,
        signal,
      );
      return b.scanRecord;
    } catch (e) {
      throw toApiError(e, "UPLOAD_FAILED", errorCopy("UPLOAD_FAILED"));
    }
  }
  // --- mock ---
  await delay(1700, signal);
  if (mockOverrides.forceReportMissing) {
    throw new ApiError("REPORT_MISSING", errorCopy("REPORT_MISSING"));
  }
  return recordFor(packageName, { version });
}

/**
 * Load the full normalized ReportSchema from a record's publicReportUrl (§5.4).
 * In mock mode it resolves from fixtures keyed by package name. Returns null
 * when no report can be loaded (caller renders the "no report" fallback).
 */
export async function getReport(
  scanRecord: ScanRecord,
  signal?: AbortSignal,
): Promise<ReportSchema | null> {
  if (!scanRecord || !scanRecord.publicReportUrl) return null;
  if (!USE_MOCK) {
    try {
      return await fetchT(scanRecord.publicReportUrl, { method: "GET" }, T_RESOLVE, signal);
    } catch {
      return null;
    }
  }
  // --- mock ---
  await delay(450, signal);
  const r = REPORTS[scanRecord.packageName];
  if (!r) return null;
  return {
    packageName: r.packageName,
    version: scanRecord.version || r.version,
    verdict: r.verdict,
    riskScore: r.riskScore,
    findings: r.findings.slice(),
  };
}

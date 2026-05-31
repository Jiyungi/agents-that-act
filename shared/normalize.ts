/**
 * Report normalizer + fail-safe defaulting (Person B, task 9.1; Reqs 12, 13).
 *
 * Maps untrusted RAW Opsera scan output (Semgrep + Gitleaks; JSON, or any other
 * text we hand through) into the normalized {@link ReportSchema} both Person A
 * and Person B agree on. The verdict is DERIVED from the (validated) riskScore
 * and threshold (Req 13), and every field is bounded / fail-safe-defaulted so a
 * malformed report never reads as falsely "safe".
 *
 * This module is the single real normalizer that replaces the temporary stub
 * in `packguard-agent/src/upload.ts`. It is wired into the upload trigger at
 * integration time (task 17.1).
 *
 * ── Order of operations (design.md → Data Models) ─────────────────────────
 *   1. Apply Req 12.5 fail-safe defaults (an ABSENT riskScore → 100).
 *   2. Validate the range per Req 13.6 (a PRESENT-but-out-of-range/non-integer
 *      riskScore → reject with INVALID_RISK_SCORE; no verdict assigned).
 *   3. Derive the verdict deterministically from (riskScore, threshold).
 *
 * Fail-safe defaults (Req 12.5):
 *   | missing field        | default        |
 *   |----------------------|----------------|
 *   | riskScore (absent)   | 100            |
 *   | findings             | []             |
 *   | severity             | CRITICAL       |
 *   | lineNumber           | 0              |
 *   | required string      | "unknown"      |
 *   | verdict              | RISKY (via the 100-score default → derived RISKY) |
 */

import type { Finding, ReportSchema, Severity, Verdict } from "./report.js";
import { UploadErrorType } from "./errors.js";
import { deriveVerdict, isValidRiskScore, DEFAULT_RISK_THRESHOLD } from "./verdict.js";

/** Placeholder for a missing required string field (Req 12.5). */
export const PLACEHOLDER_STRING = "unknown";

/** The ordered, case-sensitive severity set (Req 12.7). */
export const SEVERITIES: readonly Severity[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

/** Schema bounds from Req 12.1/12.2. */
export const SCHEMA_BOUNDS = {
  packageNameMax: 214,
  versionMax: 256,
  categoryMax: 100,
  filePathMax: 4096,
  codeSnippetMax: 1000,
  maxFindings: 1000,
} as const;

/**
 * Result of {@link normalizeReport}. Either a schema-conformant report, or a
 * rejection for a PRESENT-but-invalid riskScore (Req 13.6).
 */
export type NormalizeResult =
  | { ok: true; report: ReportSchema }
  | {
      ok: false;
      errorType: typeof UploadErrorType.INVALID_RISK_SCORE;
      message: string;
    };

export interface NormalizeOptions {
  /** Verdict threshold T (frozen per record at creation). Defaults to 50. */
  threshold?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Coerce to a bounded non-empty string, falling back to the placeholder. */
function boundedRequiredString(value: unknown, max: number): string {
  const s = typeof value === "string" ? value.trim() : "";
  const chosen = s === "" ? PLACEHOLDER_STRING : s;
  return chosen.length > max ? chosen.slice(0, max) : chosen;
}

/** Coerce to a bounded optional string (may be empty), clamped to `max`. */
function boundedOptionalString(value: unknown, max: number): string {
  const s = typeof value === "string" ? value : "";
  return s.length > max ? s.slice(0, max) : s;
}

/** Normalize a single raw finding, applying fail-safe defaults (Req 12.5). */
export function normalizeFinding(raw: unknown): Finding {
  const obj = asRecord(raw) ?? {};

  const rawLine = obj["lineNumber"];
  const lineNumber =
    typeof rawLine === "number" && Number.isInteger(rawLine) && rawLine >= 0
      ? rawLine
      : 0; // missing/invalid → 0 (Req 12.5)

  const rawSeverity = obj["severity"];
  const severity: Severity =
    typeof rawSeverity === "string" &&
    (SEVERITIES as readonly string[]).includes(rawSeverity)
      ? (rawSeverity as Severity)
      : "CRITICAL"; // missing → CRITICAL (Req 12.5)

  return {
    category: boundedRequiredString(obj["category"], SCHEMA_BOUNDS.categoryMax),
    filePath: boundedRequiredString(obj["filePath"], SCHEMA_BOUNDS.filePathMax),
    lineNumber,
    severity,
    codeSnippet: boundedOptionalString(obj["codeSnippet"], SCHEMA_BOUNDS.codeSnippetMax),
  };
}

/**
 * Extract the raw findings array from a report. Prefers an explicit `findings`
 * array; falls back to a Semgrep-style `results` array so a raw Semgrep report
 * still yields findings. Returns an empty array when neither is present
 * (Req 12.5 fail-safe default).
 */
function extractRawFindings(root: Record<string, unknown>): unknown[] {
  if (Array.isArray(root["findings"])) return root["findings"] as unknown[];
  if (Array.isArray(root["results"])) {
    // Best-effort Semgrep `results[]` → Finding mapping.
    return (root["results"] as unknown[]).map((r) => mapSemgrepResult(r));
  }
  return [];
}

/** Map a single Semgrep `results[]` entry to a raw finding shape. */
function mapSemgrepResult(raw: unknown): Record<string, unknown> {
  const obj = asRecord(raw) ?? {};
  const start = asRecord(obj["start"]);
  const extra = asRecord(obj["extra"]);
  const severityRaw =
    typeof extra?.["severity"] === "string" ? (extra["severity"] as string) : "";
  return {
    category: typeof obj["check_id"] === "string" ? obj["check_id"] : "semgrep",
    filePath: typeof obj["path"] === "string" ? obj["path"] : PLACEHOLDER_STRING,
    lineNumber: typeof start?.["line"] === "number" ? start["line"] : 0,
    severity: mapSemgrepSeverity(severityRaw),
    codeSnippet:
      typeof extra?.["lines"] === "string" ? (extra["lines"] as string) : "",
  };
}

/** Map Semgrep severity strings (ERROR/WARNING/INFO) to the schema set. */
function mapSemgrepSeverity(value: string): Severity {
  switch (value.toUpperCase()) {
    case "ERROR":
      return "HIGH";
    case "WARNING":
      return "MEDIUM";
    case "INFO":
      return "LOW";
    default:
      return (SEVERITIES as readonly string[]).includes(value.toUpperCase())
        ? (value.toUpperCase() as Severity)
        : "CRITICAL";
  }
}

/**
 * Normalize raw Opsera output into a schema-conformant {@link ReportSchema}.
 *
 * The verdict is DERIVED from the validated riskScore and threshold (Req 13);
 * any verdict present in the raw report is ignored in favour of the
 * deterministic derivation. The caller (upload trigger) overrides
 * `packageName`/`version` with the authoritative resolved identity.
 *
 * Rejects ONLY a present-but-invalid riskScore (Req 13.6); every other missing
 * or malformed field is fail-safe-defaulted (Req 12.5).
 */
export function normalizeReport(
  raw: unknown,
  options: NormalizeOptions = {},
): NormalizeResult {
  const threshold = options.threshold ?? DEFAULT_RISK_THRESHOLD;
  const root = asRecord(raw) ?? {};

  // 1) riskScore: ABSENT → fail-safe default 100 (Req 12.5).
  const rawScore = root["riskScore"];
  let riskScore: number;
  if (rawScore === undefined || rawScore === null) {
    riskScore = 100;
  } else if (isValidRiskScore(rawScore)) {
    // 2) PRESENT and a valid integer in 0..100.
    riskScore = rawScore;
  } else {
    // 2) PRESENT but out-of-range / non-integer → reject (Req 13.6).
    return {
      ok: false,
      errorType: UploadErrorType.INVALID_RISK_SCORE,
      message: `riskScore must be an integer in 0..100; got ${JSON.stringify(rawScore)}`,
    };
  }

  // 3) Derive the verdict deterministically (Req 13.2/13.3/13.4).
  const verdict: Verdict = deriveVerdict(riskScore, threshold);

  const findings = extractRawFindings(root)
    .slice(0, SCHEMA_BOUNDS.maxFindings) // cap at 1000 (Req 12.1)
    .map(normalizeFinding);

  return {
    ok: true,
    report: {
      packageName: boundedRequiredString(root["packageName"], SCHEMA_BOUNDS.packageNameMax),
      version: boundedRequiredString(root["version"], SCHEMA_BOUNDS.versionMax),
      verdict,
      riskScore,
      findings,
    },
  };
}

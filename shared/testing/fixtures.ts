/**
 * Sample fixtures for cross-person integration and tests.
 *
 * Two families:
 *  1. Normalized {@link ReportSchema} fixtures — already conform to the
 *     Report_Schema (Req 12). Person B's verdict card / gallery render against
 *     these; the Storage_Service fake stores them.
 *  2. Raw-Opsera-output fixtures — the loosely-shaped JSON the Opsera_Agent
 *     (Semgrep + Gitleaks) writes to `reportPath`. These feed the normalizer
 *     (task 9.1). Both **well-formed** and **malformed** (missing-field)
 *     variants are provided so fail-safe-default behavior (Req 12.5,
 *     Property 10) can be exercised later.
 *
 * The raw fixtures are intentionally typed loosely (`RawOpseraReport`) because
 * real Opsera output is untrusted/unnormalized — the normalizer's whole job is
 * to map this shape into the strict {@link ReportSchema}.
 */

import type { Finding, ReportSchema } from "../report.js";

// ---------------------------------------------------------------------------
// 1) Normalized Report_Schema fixtures (already conform to Req 12)
// ---------------------------------------------------------------------------

/** A SAFE report with zero findings (exercises Req 11.5 render branch). */
export const SAFE_REPORT_NO_FINDINGS: ReportSchema = {
  packageName: "left-pad",
  version: "1.3.0",
  verdict: "SAFE",
  riskScore: 5,
  findings: [],
};

/** A RISKY report with several findings across severities (render coverage). */
export const RISKY_REPORT_WITH_FINDINGS: ReportSchema = {
  packageName: "@acme/widget",
  version: "2.1.4",
  verdict: "RISKY",
  riskScore: 87,
  findings: [
    {
      category: "hardcoded-secret",
      filePath: "src/config.js",
      lineNumber: 42,
      severity: "CRITICAL",
      codeSnippet: 'const token = "ghp_exampleSecretValue1234567890";',
    },
    {
      category: "command-injection",
      filePath: "lib/exec.js",
      lineNumber: 17,
      severity: "HIGH",
      codeSnippet: "child_process.exec(`rm -rf ${userInput}`);",
    },
    {
      category: "insecure-random",
      filePath: "src/token.js",
      lineNumber: 0, // unspecified line (Req 12.2)
      severity: "MEDIUM",
      codeSnippet: "", // no snippet → "source line unavailable" (Req 11.7)
    },
  ],
};

/** A finding with no code snippet, for the "source line unavailable" branch. */
export const FINDING_WITHOUT_SNIPPET: Finding = {
  category: "missing-snippet",
  filePath: "src/unknown.js",
  lineNumber: 3,
  severity: "LOW",
  codeSnippet: "",
};

/** All normalized Report_Schema fixtures, for table-driven tests. */
export const NORMALIZED_REPORT_FIXTURES: readonly ReportSchema[] = [
  SAFE_REPORT_NO_FINDINGS,
  RISKY_REPORT_WITH_FINDINGS,
];

// ---------------------------------------------------------------------------
// 2) Raw Opsera output fixtures (pre-normalization)
// ---------------------------------------------------------------------------

/**
 * Loosely-typed raw Opsera scan output. Every field is optional/unknown
 * because the raw artifact is untrusted: the normalizer (task 9.1) is what
 * fills missing fields with fail-safe defaults (Req 12.5) and validates
 * ranges (Req 13.6). Extra/unknown keys are permitted and ignored.
 */
export interface RawOpseraReport {
  packageName?: unknown;
  version?: unknown;
  verdict?: unknown;
  riskScore?: unknown;
  findings?: unknown;
  [key: string]: unknown;
}

/** A fully-populated, well-formed raw report (normalizes with no defaulting). */
export const RAW_OPSERA_WELL_FORMED: RawOpseraReport = {
  packageName: "left-pad",
  version: "1.3.0",
  verdict: "SAFE",
  riskScore: 8,
  findings: [
    {
      category: "info-leak",
      filePath: "index.js",
      lineNumber: 10,
      severity: "LOW",
      codeSnippet: "console.log(process.env);",
    },
  ],
  // Extra keys Opsera may emit; the normalizer should ignore these.
  tool: "semgrep+gitleaks",
  generatedAt: "2024-01-01T00:00:00.000Z",
};

/** Well-formed RISKY raw report with multiple findings. */
export const RAW_OPSERA_WELL_FORMED_RISKY: RawOpseraReport = {
  packageName: "@acme/widget",
  version: "2.1.4",
  verdict: "RISKY",
  riskScore: 91,
  findings: [
    {
      category: "hardcoded-secret",
      filePath: "src/config.js",
      lineNumber: 42,
      severity: "CRITICAL",
      codeSnippet: 'const token = "ghp_exampleSecretValue1234567890";',
    },
    {
      category: "command-injection",
      filePath: "lib/exec.js",
      lineNumber: 17,
      severity: "HIGH",
      codeSnippet: "child_process.exec(`rm -rf ${userInput}`);",
    },
  ],
};

/**
 * Malformed: completely empty object. Every field is missing, so the
 * normalizer must apply ALL fail-safe defaults (verdict→RISKY, riskScore→100,
 * findings→[], required strings→placeholder) — the pessimistic case
 * (Req 12.5, Property 10).
 */
export const RAW_OPSERA_EMPTY: RawOpseraReport = {};

/**
 * Malformed: missing top-level `verdict` and `riskScore`. Defaults should be
 * verdict→RISKY and riskScore→100.
 */
export const RAW_OPSERA_MISSING_VERDICT_AND_SCORE: RawOpseraReport = {
  packageName: "sketchy-pkg",
  version: "0.0.1",
  findings: [
    {
      category: "eval-usage",
      filePath: "main.js",
      lineNumber: 5,
      severity: "HIGH",
      codeSnippet: "eval(userInput);",
    },
  ],
};

/**
 * Malformed: a finding missing `severity` and `lineNumber`. Per-finding
 * defaults should be severity→CRITICAL and lineNumber→0 (Req 12.5).
 */
export const RAW_OPSERA_FINDING_MISSING_FIELDS: RawOpseraReport = {
  packageName: "partial-finding",
  version: "1.0.0",
  verdict: "RISKY",
  riskScore: 60,
  findings: [
    {
      // category and filePath present; severity + lineNumber absent.
      category: "weak-crypto",
      filePath: "crypto.js",
      codeSnippet: "crypto.createHash('md5');",
    },
  ],
};

/**
 * Malformed: missing required strings (`packageName`, `version`) and a finding
 * with no `category`/`filePath`. Missing required strings should default to a
 * placeholder value (Req 12.5).
 */
export const RAW_OPSERA_MISSING_REQUIRED_STRINGS: RawOpseraReport = {
  verdict: "RISKY",
  riskScore: 100,
  findings: [
    {
      lineNumber: 1,
      severity: "MEDIUM",
      codeSnippet: "var x = 1;",
    },
  ],
};

/**
 * Malformed in a way the normalizer must REJECT, not default: a present but
 * out-of-range `riskScore` (Req 13.6 → `INVALID_RISK_SCORE`). Defaulting is
 * only for *absent* fields; a present-but-invalid score is an error.
 */
export const RAW_OPSERA_OUT_OF_RANGE_SCORE: RawOpseraReport = {
  packageName: "bad-score",
  version: "1.0.0",
  verdict: "RISKY",
  riskScore: 150,
  findings: [],
};

/** Well-formed raw fixtures (normalize without rejection). */
export const RAW_OPSERA_WELL_FORMED_FIXTURES: readonly RawOpseraReport[] = [
  RAW_OPSERA_WELL_FORMED,
  RAW_OPSERA_WELL_FORMED_RISKY,
];

/** Malformed (missing-field) raw fixtures that exercise fail-safe defaults. */
export const RAW_OPSERA_MALFORMED_FIXTURES: readonly RawOpseraReport[] = [
  RAW_OPSERA_EMPTY,
  RAW_OPSERA_MISSING_VERDICT_AND_SCORE,
  RAW_OPSERA_FINDING_MISSING_FIELDS,
  RAW_OPSERA_MISSING_REQUIRED_STRINGS,
];

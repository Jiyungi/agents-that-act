/**
 * Shared Report_Schema contract (design.md → "Data Models → Report_Schema",
 * Req 12). This is the normalized report both Person A and Person B agree on:
 * raw Opsera output (Semgrep + Gitleaks, HTML/MD/JSON) is mapped into this
 * exact shape by the normalizer in the upload trigger.
 *
 * Field types, value sets, and bounds match the design's Data Models section.
 * Bounds are documented here as comments; runtime validation/normalization
 * lands with the normalizer (task 9.1).
 */

/**
 * Top-level package classification. Case-sensitive — exactly `SAFE` or `RISKY`
 * (Req 12.3). String-literal union per task constraints.
 */
export type Verdict = "SAFE" | "RISKY";

/**
 * Finding severity. The ordered, case-sensitive set LOW < MEDIUM < HIGH <
 * CRITICAL (Req 12.7). String-literal union per task constraints.
 */
export type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/**
 * A single security issue within a Scan_Report (Req 12.2).
 *
 * Bounds (validated by the normalizer):
 *  - category:    string, 1..100 chars
 *  - filePath:    string, 1..4096 chars
 *  - lineNumber:  integer >= 0 (0 = unspecified line)
 *  - severity:    one of {@link Severity}
 *  - codeSnippet: string, 0..1000 chars — the actual risky source line(s)
 */
export interface Finding {
  /** Issue category label. 1..100 chars (Req 12.2). */
  category: string;
  /** Path of the offending file. 1..4096 chars (Req 12.2). */
  filePath: string;
  /** 1-based source line; integer >= 0, where 0 means unspecified (Req 12.2). */
  lineNumber: number;
  /** Severity bucket (Req 12.2, 12.7). */
  severity: Severity;
  /** The actual risky source line(s). 0..1000 chars (Req 12.2). */
  codeSnippet: string;
}

/**
 * The normalized report shared between Person A and Person B (Req 12.1).
 *
 * Bounds (validated by the normalizer):
 *  - packageName: string, 1..214 chars
 *  - version:     string, 1..256 chars
 *  - verdict:     {@link Verdict}
 *  - riskScore:   integer 0..100 inclusive (Reqs 12.6, 13.1)
 *  - findings:    0..1000 items (Req 12.1)
 */
export interface ReportSchema {
  /** Resolved package name. 1..214 chars (Req 12.1). */
  packageName: string;
  /** Resolved version. 1..256 chars (Req 12.1). */
  version: string;
  /** SAFE/RISKY classification derived from riskScore + threshold (Req 12.3). */
  verdict: Verdict;
  /** Integer risk score, 0..100 inclusive (Reqs 12.6, 13.1). */
  riskScore: number;
  /** Findings collection, 0..1000 items (Req 12.1). */
  findings: Finding[];
}

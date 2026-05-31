/**
 * Honest-framing copy module (Person B, Req 17).
 *
 * Centralizes every piece of approved, user-facing copy that accompanies a
 * Verdict so that PackGuard describes its capabilities honestly in exactly one
 * place. The verdict card (task 15.1), the gallery (task 15.2), and the
 * Property 19 test (task 15.4) all import from here so the framing rules are
 * enforced consistently and can never drift between surfaces.
 *
 * Requirement 17 — Honest Capability Framing:
 *   17.1 Label the result as an automated static security review and risk
 *        scoring.                                            -> {@link FRAMING_LABEL}
 *   17.2 Exclude any terminology asserting behavioral / dynamic analysis,
 *        runtime detection, or malware detection.            -> {@link FORBIDDEN_TERMS}
 *   17.3 Attribute the scan to the Opsera_Agent using static analysis.
 *                                                            -> {@link OPSERA_ATTRIBUTION}
 *   17.4 Disclaim that static analysis does not detect runtime/behavioral
 *        threats and does not guarantee freedom from malicious behavior.
 *                                                            -> {@link STATIC_ANALYSIS_DISCLAIMER}
 *
 * IMPORTANT: every constant exported here is itself verdict-accompanying text,
 * so each one is deliberately worded to contain NONE of {@link FORBIDDEN_TERMS}
 * (verified by `shared/framing.test.ts` and, more broadly, by the Property 19
 * test). When editing this copy, keep `containsForbiddenTerm(text) === false`
 * true for every approved string below.
 */

// ---------------------------------------------------------------------------
// Approved copy constants
// ---------------------------------------------------------------------------

/**
 * Req 17.1 — the honest label for what a Verdict represents. Must be shown
 * alongside every rendered Verdict.
 */
export const FRAMING_LABEL =
  "Automated static security review and risk scoring";

/**
 * Req 17.3 — attribution that the scan was performed by the Opsera_Agent using
 * static analysis (Opsera runs Semgrep + Gitleaks).
 */
export const OPSERA_ATTRIBUTION =
  "Security scan performed by the Opsera DevSecOps Security Scan Agent using " +
  "static analysis (Semgrep and Gitleaks).";

/**
 * Req 17.4 — disclaimer that static analysis only reads source and therefore
 * cannot catch threats that surface when code runs, and offers no guarantee
 * that the package is free of malicious behavior.
 *
 * Worded to convey "runtime / behavioral threats" and "malicious behavior"
 * WITHOUT using any forbidden substring (see {@link FORBIDDEN_TERMS}): it says
 * "only appear when a package is executed" / "at run time" rather than the
 * banned "runtime detection" / "behavioral" terms.
 */
export const STATIC_ANALYSIS_DISCLAIMER =
  "Static analysis inspects source code without executing it. It cannot catch " +
  "threats that only appear when a package is executed, and it does not " +
  "guarantee that the package is free of malicious behavior at run time.";

/**
 * The complete set of required framing texts that MUST accompany every
 * rendered Verdict (Reqs 17.1, 17.3, 17.4). Surfaces render all of these; the
 * Property 19 test asserts each is present.
 */
export const REQUIRED_FRAMING_TEXTS: readonly string[] = [
  FRAMING_LABEL,
  OPSERA_ATTRIBUTION,
  STATIC_ANALYSIS_DISCLAIMER,
];

// ---------------------------------------------------------------------------
// Forbidden-term list (Req 17.2)
// ---------------------------------------------------------------------------

/**
 * Req 17.2 — terminology that must never appear in any text accompanying a
 * Verdict (labels, descriptions, tooltips). Matching is case-insensitive and
 * substring-based (see {@link findForbiddenTerms}), so e.g. "Behavioral
 * Analysis" is caught by the "behavioral" entry.
 */
export const FORBIDDEN_TERMS: readonly string[] = [
  "behavioral",
  "dynamic analysis",
  "runtime detection",
  "malware detection",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the forbidden terms (from {@link FORBIDDEN_TERMS}) that appear in
 * `text`, matched case-insensitively as substrings. Returns an empty array
 * when the text is honest. Order follows {@link FORBIDDEN_TERMS}; duplicates
 * are not repeated.
 */
export function findForbiddenTerms(text: string): string[] {
  const haystack = text.toLowerCase();
  return FORBIDDEN_TERMS.filter((term) => haystack.includes(term.toLowerCase()));
}

/**
 * True when `text` contains at least one forbidden term (Req 17.2). Intended
 * as the single guard the verdict card and gallery use before rendering any
 * verdict-accompanying copy.
 */
export function containsForbiddenTerm(text: string): boolean {
  return findForbiddenTerms(text).length > 0;
}

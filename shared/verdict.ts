/**
 * Verdict derivation from a risk score (Person B, task 10.1; Req 13).
 *
 * A single threshold `T` (a constant in 0..100, default 50) separates a SAFE
 * verdict from a RISKY one:
 *   - `riskScore < T`  → `SAFE`  (Req 13.2)
 *   - `riskScore >= T` → `RISKY` (Req 13.3)
 *
 * Derivation is a PURE function of `(riskScore, T)` so it is deterministic
 * (Req 13.4): the same inputs always yield the same verdict. Persisted records
 * freeze the `thresholdUsed` at creation time so later threshold changes never
 * retroactively alter a stored verdict (Req 13.5) — that freezing happens in
 * the Storage_Service, not here.
 */

import type { Verdict } from "./report.js";
import { CONFIG_DEFAULTS } from "./config.js";

/** Default verdict threshold T (design default 50). */
export const DEFAULT_RISK_THRESHOLD = CONFIG_DEFAULTS.RISK_THRESHOLD;

/**
 * Derive the SAFE/RISKY verdict from an integer `riskScore` and threshold `T`.
 *
 * Pure + total over the documented domain (`riskScore` and `T` both integers
 * in 0..100): `SAFE` iff `riskScore < T`, else `RISKY` (Reqs 13.2, 13.3, 13.4).
 *
 * This function assumes `riskScore` has already been validated to be an integer
 * in 0..100 (the normalizer enforces Req 13.6 before calling here).
 */
export function deriveVerdict(
  riskScore: number,
  threshold: number = DEFAULT_RISK_THRESHOLD,
): Verdict {
  return riskScore < threshold ? "SAFE" : "RISKY";
}

/** `true` iff `value` is an integer in the inclusive range 0..100 (Req 13.1/13.6). */
export function isValidRiskScore(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 100
  );
}

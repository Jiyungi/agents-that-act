/* ============================================================
 * framing.ts — SINGLE SOURCE OF TRUTH for verdict-accompanying copy.
 * ------------------------------------------------------------
 * Honest framing (Req 17) is anchored to the canonical constants in
 * `shared/framing.ts` so the frontend can never drift from the backend's
 * approved copy. The required label / attribution / disclaimer are imported
 * verbatim; the remaining strings are UI-only copy (validation, gallery
 * states, agent health, handoff steps) that still pass the forbidden-term
 * guard exported here.
 * ============================================================ */
import {
  FRAMING_LABEL,
  OPSERA_ATTRIBUTION,
  STATIC_ANALYSIS_DISCLAIMER,
  FORBIDDEN_TERMS,
  findForbiddenTerms,
  containsForbiddenTerm,
} from "@shared/framing";

export { FORBIDDEN_TERMS, findForbiddenTerms, containsForbiddenTerm };

export const FRAMING = {
  // product
  productName: "PackGuard",
  tagline:
    "Inspect npm packages before you install — automated static security review.",

  // §8 required — present results honestly (canonical, from shared/framing.ts)
  resultsLabel: FRAMING_LABEL,
  resultsLabelShort: "Static security review",

  // §8 required — attribution (canonical, from shared/framing.ts)
  attribution: OPSERA_ATTRIBUTION,
  attributionShort: "Opsera DevSecOps Agent · Semgrep + Gitleaks",

  // §8 required — disclaimer (canonical, from shared/framing.ts)
  disclaimer: STATIC_ANALYSIS_DISCLAIMER,

  // verdict words / derivation
  verdictSafe: "SAFE",
  verdictRisky: "RISKY",
  safeBlurb: "Risk score is below the configured threshold.",
  riskyBlurb: "Risk score is at or above the configured threshold.",

  // findings + fallbacks (§7)
  findingsTitle: "Findings",
  noFindings: "No findings were reported.",
  sourceLineUnavailable: "Source line unavailable.",
  unspecifiedLine: "unspecified line",
  noReport: "No scan report is available for this package.",
  shareLabel: "Shareable report",
  shareUnavailable: "Shareable link unavailable.",

  // gallery (§9)
  galleryTitle: "Scanned packages",
  gallerySub: "Every scanned package version, newest first.",
  galleryEmpty: "No scanned packages yet.",
  galleryPartial: "Some records could not be loaded.",
  galleryUnavailable: "The gallery could not be loaded.",

  // agent health (§5)
  agentMissing:
    "Local PackGuard agent not detected. Start it with `npx packguard-agent` to fetch and scan packages.",
  agentNoCode:
    "VS Code `code` CLI not found. The agent can fetch packages, but won't be able to open them automatically.",
  agentOk: "Local agent connected",
  agentChecking: "Checking local agent…",

  // search validation (§6)
  pkgRequired: "Package name is required.",
  scanningUnavailable: "Scanning service unavailable.",
  resolveTimeout: "Resolve timed out. The npm registry took too long to respond.",
  flowTimeout: "Scan timed out. Please try again.",

  // manual handoff (§5)
  handoffTitle: "Manual scan handoff",
  handoffBadge: "Action required",
  handoffStep1: "VS Code has opened on the unpacked package source.",
  handoffStep2html:
    "In <b>GitHub Copilot Chat</b>, run <code>/security-scan</code> and wait for it to finish.",
  handoffStep3html: "When the report is written, click <b>Upload report</b> below.",
} as const;

/**
 * Human-readable error copy keyed by the contract error strings (FetchErrorType
 * / UploadErrorType, plus client-only TIMEOUT / NETWORK). Falls back to the
 * server-provided message when a code is unmapped.
 */
export const ERROR_COPY: Record<string, string> = {
  INVALID_PACKAGE_NAME: "That isn't a valid npm package name.",
  PACKAGE_UNRESOLVED: "No package by that name was found on the npm registry.",
  VERSION_UNRESOLVED: "That version could not be resolved on the registry.",
  REGISTRY_UNAVAILABLE: "The npm registry is unavailable right now. Try again shortly.",
  DOWNLOAD_FAILED: "The package tarball could not be downloaded.",
  DOWNLOAD_TOO_LARGE: "The package exceeds the maximum allowed download size.",
  PATH_TRAVERSAL: "The package archive contained an unsafe path and was rejected.",
  ABSOLUTE_PATH: "The package archive contained an absolute path and was rejected.",
  LINK_TARGET_ESCAPE:
    "A symlink in the archive pointed outside the extraction root and was rejected.",
  RESOURCE_LIMIT_EXCEEDED: "Extraction exceeded resource limits and was stopped.",
  EXTRACTION_TIMEOUT: "Extraction took too long and was stopped.",
  VSCODE_UNAVAILABLE: "VS Code's `code` CLI is not available on this machine.",
  VSCODE_LAUNCH_FAILED: "VS Code could not be launched automatically.",
  REPORT_MISSING:
    "No report file was found. Make sure /security-scan finished writing it.",
  INVALID_IDENTIFIER: "The scan identifier was invalid.",
  UPLOAD_FAILED: "The report could not be uploaded. Please retry.",
  INVALID_RISK_SCORE: "The report's risk score was outside the valid range (0–100).",
};

export function errorCopy(code: string | undefined, fallback?: string): string {
  if (code && ERROR_COPY[code]) return ERROR_COPY[code];
  return fallback || "Something went wrong.";
}

/** Phase labels for the 4-step progress affordance (§10). */
export interface PhaseDef {
  key: "resolve" | "fetch" | "scan" | "upload";
  name: string;
  desc: string;
}

export const PHASES: PhaseDef[] = [
  { key: "resolve", name: "Resolve", desc: "Look up the package on the npm registry" },
  {
    key: "fetch",
    name: "Fetch & open",
    desc: "Unpack source & open in VS Code — never installed",
  },
  { key: "scan", name: "Run scan", desc: "Operator runs /security-scan in Copilot Chat" },
  { key: "upload", name: "Upload", desc: "Normalize, score & publish the report" },
];

/**
 * Forbidden-term self-check (§8 / Req 17.2). Returns offending `[key, term]`
 * pairs across every string in {@link FRAMING}; an empty array means the copy
 * is honest. Exercised by the unit test in `framing.test.ts`.
 */
export function assertNoForbiddenTerms(): Array<[string, string]> {
  const offences: Array<[string, string]> = [];
  for (const [key, val] of Object.entries(FRAMING)) {
    if (typeof val !== "string") continue;
    for (const term of findForbiddenTerms(val)) {
      offences.push([key, term]);
    }
  }
  return offences;
}

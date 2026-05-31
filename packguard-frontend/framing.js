/* ============================================================
 * framing.ts  (shipped as plain JS for the prototype)
 * ------------------------------------------------------------
 * SINGLE SOURCE OF TRUTH for every piece of verdict-accompanying
 * copy. Never write verdict labels/descriptions/captions ad hoc —
 * import from here so honest framing is enforced in one place.
 *
 * In the Next.js app this is `framing.ts`; the FRAMING object and
 * assertNoForbiddenTerms() guard port over verbatim.
 * ============================================================ */
(function () {
  "use strict";

  var FRAMING = {
    // product
    productName: "PackGuard",
    tagline:
      "Inspect npm packages before you install — automated static security review.",

    // §8 required: present results honestly
    resultsLabel: "Automated static security review and risk scoring",
    resultsLabelShort: "Static security review",

    // §8 required: attribution
    attribution:
      "Scan performed by the Opsera DevSecOps Security Scan Agent using static analysis (Semgrep + Gitleaks).",
    attributionShort: "Opsera DevSecOps Agent · Semgrep + Gitleaks",

    // §8 required: disclaimer (worded to avoid asserting behavioral/runtime/dynamic detection)
    disclaimer:
      "Static analysis inspects source code only. It does not detect threats that appear only when a package is executed, and does not guarantee the package is free of malicious behavior.",

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
    handoffStep3html:
      'When the report is written, click <b>Upload report</b> below.',
  };

  // Human-readable error copy keyed by the contract error strings (§3).
  // Falls back to the server-provided message when a code is unmapped.
  var ERROR_COPY = {
    INVALID_PACKAGE_NAME: "That isn't a valid npm package name.",
    PACKAGE_UNRESOLVED: "No package by that name was found on the npm registry.",
    VERSION_UNRESOLVED: "That version could not be resolved on the registry.",
    REGISTRY_UNAVAILABLE: "The npm registry is unavailable right now. Try again shortly.",
    DOWNLOAD_FAILED: "The package tarball could not be downloaded.",
    DOWNLOAD_TOO_LARGE: "The package exceeds the maximum allowed download size.",
    PATH_TRAVERSAL: "The package archive contained an unsafe path and was rejected.",
    ABSOLUTE_PATH: "The package archive contained an absolute path and was rejected.",
    LINK_TARGET_ESCAPE: "A symlink in the archive pointed outside the extraction root and was rejected.",
    RESOURCE_LIMIT_EXCEEDED: "Extraction exceeded resource limits and was stopped.",
    EXTRACTION_TIMEOUT: "Extraction took too long and was stopped.",
    VSCODE_UNAVAILABLE: "VS Code's `code` CLI is not available on this machine.",
    VSCODE_LAUNCH_FAILED: "VS Code could not be launched automatically.",
    REPORT_MISSING: "No report file was found. Make sure /security-scan finished writing it.",
    INVALID_IDENTIFIER: "The scan identifier was invalid.",
    UPLOAD_FAILED: "The report could not be uploaded. Please retry.",
    INVALID_RISK_SCORE: "The report's risk score was outside the valid range (0–100).",
  };

  // Phase labels for the 4-step progress affordance (§10).
  var PHASES = [
    { key: "resolve", name: "Resolve",  desc: "Look up the package on the npm registry" },
    { key: "fetch",   name: "Fetch & open", desc: "Unpack source & open in VS Code — never installed" },
    { key: "scan",    name: "Run scan", desc: "Operator runs /security-scan in Copilot Chat" },
    { key: "upload",  name: "Upload",   desc: "Normalize, score & publish the report" },
  ];

  /* ----------------------------------------------------------
   * Forbidden-term guard (§8). Asserts none of the dishonest
   * terms appear in any exported framing string. Returns the
   * list of offending [key, term] pairs (empty = clean).
   * In the Next.js app this is exercised by a unit test:
   *   expect(assertNoForbiddenTerms()).toEqual([]);
   * -------------------------------------------------------- */
  var FORBIDDEN = ["behavioral", "dynamic analysis", "runtime detection", "malware detection"];

  function assertNoForbiddenTerms() {
    var offences = [];
    Object.keys(FRAMING).forEach(function (key) {
      var val = FRAMING[key];
      if (typeof val !== "string") return;
      var hay = val.toLowerCase();
      FORBIDDEN.forEach(function (term) {
        if (hay.indexOf(term) !== -1) offences.push([key, term]);
      });
    });
    return offences;
  }

  function errorCopy(code, fallback) {
    return ERROR_COPY[code] || fallback || "Something went wrong.";
  }

  // self-check on load — log loudly if framing ever drifts
  var __offences = assertNoForbiddenTerms();
  if (__offences.length) {
    console.error("[framing] forbidden terms present:", __offences);
  }

  window.FRAMING = FRAMING;
  window.ERROR_COPY = ERROR_COPY;
  window.PHASES = PHASES;
  window.FORBIDDEN_TERMS = FORBIDDEN;
  window.assertNoForbiddenTerms = assertNoForbiddenTerms;
  window.errorCopy = errorCopy;
})();

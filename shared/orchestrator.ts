/**
 * Agentic scan orchestrator — chains all three sponsor tools, no human step.
 *
 *   Daytona  → isolated sandbox: fetch + safe-untar the npm tarball (untrusted
 *              code never touches the host) and run the static security scanners
 *   Opsera   → the DevSecOps static scan (Semgrep + Gitleaks) executed in the
 *              sandbox; raw findings normalized to the shared Report_Schema
 *   Tigris   → store the report + source snapshot + Scan_Record; gallery updates
 *
 * This is the productionized version of the Person C feasibility experiment:
 * what was proven manually now runs end-to-end from a single call, so the
 * Vercel UI's "Scan" button is fully agentic.
 */

import { DaytonaClient } from "./daytona.js";
import { normalizeReport } from "./normalize.js";
import { TigrisStorageService, type StorageService } from "./storage.js";
import type { Finding, ReportSchema, Severity } from "./report.js";
import type { ScanRecord } from "./scan.js";
import { validatePackageName } from "./package-name.js";

export interface OrchestratorDeps {
  daytona?: DaytonaClient;
  storage?: StorageService;
  /** Verdict threshold T. Defaults to RISK_THRESHOLD / 50. */
  threshold?: number;
  /** Progress callback for streaming step updates to the UI/logs. */
  onStep?: (step: ScanStep) => void;
}

export interface ScanStep {
  phase:
    | "SANDBOX_CREATE"
    | "FETCH"
    | "SCAN"
    | "NORMALIZE"
    | "STORE"
    | "CLEANUP"
    | "DONE"
    | "ERROR";
  message: string;
}

export interface OrchestratorResult {
  ok: boolean;
  scanRecord?: ScanRecord;
  report?: ReportSchema;
  sandboxId?: string;
  steps: ScanStep[];
  error?: string;
}

/**
 * The shell script run INSIDE the Daytona sandbox. It:
 *   - downloads the resolved tarball and safe-untars it (no install, no exec),
 *   - installs Semgrep + Gitleaks on first run,
 *   - runs both scanners and prints their JSON between sentinels we can parse.
 * All untrusted source stays in the sandbox.
 */
function buildScanScript(packageName: string, version: string): string {
  // Use npm to resolve the exact tarball; pin the version.
  const spec = `${packageName}@${version}`;
  return [
    "cd /tmp",
    "rm -rf pkg && mkdir -p pkg/src",
    // Resolve the tarball URL; npm prints notices to stderr which we discard.
    `URL=$(npm view ${shellQuote(spec)} dist.tarball 2>/dev/null | tail -1)`,
    'if [ -z "$URL" ]; then echo "RESOLVE_FAILED"; exit 7; fi',
    'curl -sL "$URL" -o pkg/p.tgz',
    "tar -xzf pkg/p.tgz -C pkg/src 2>/dev/null || true",
    // Install scanners quietly (idempotent across reused sandboxes).
    "pip3 install --quiet semgrep >/dev/null 2>&1 || true",
    "command -v gitleaks >/dev/null 2>&1 || (curl -sL https://github.com/gitleaks/gitleaks/releases/download/v8.18.4/gitleaks_8.18.4_linux_x64.tar.gz | tar -xz -C /usr/local/bin gitleaks >/dev/null 2>&1 || true)",
    // Semgrep (SAST). Auto config; never fail the whole script on findings.
    'echo "<<<SEMGREP>>>"',
    "semgrep --config auto --json --quiet pkg/src 2>/dev/null || echo '{\"results\":[]}'",
    'echo "<<<ENDSEMGREP>>>"',
    // Gitleaks (secrets). Outputs JSON report to a file then cat it.
    'echo "<<<GITLEAKS>>>"',
    "gitleaks detect --source pkg/src --no-git --report-format json --report-path /tmp/gl.json >/dev/null 2>&1 || true",
    "cat /tmp/gl.json 2>/dev/null || echo '[]'",
    'echo "<<<ENDGITLEAKS>>>"',
  ].join("\n");
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Extract content between two sentinel lines from combined sandbox output. */
function between(output: string, start: string, end: string): string {
  const s = output.indexOf(start);
  const e = output.indexOf(end);
  if (s === -1 || e === -1 || e < s) return "";
  return output.slice(s + start.length, e).trim();
}

/** Severity mapping for Semgrep ERROR/WARNING/INFO. */
function mapSemgrepSeverity(v: string): Severity {
  switch ((v || "").toUpperCase()) {
    case "ERROR":
      return "HIGH";
    case "WARNING":
      return "MEDIUM";
    case "INFO":
      return "LOW";
    default:
      return "MEDIUM";
  }
}

/** Turn raw Semgrep + Gitleaks JSON into Report_Schema findings + a risk score. */
export function findingsFromScanners(
  semgrepJson: string,
  gitleaksJson: string,
): { findings: Finding[]; riskScore: number } {
  const findings: Finding[] = [];

  // Semgrep results[]
  try {
    const sem = JSON.parse(semgrepJson) as { results?: unknown[] };
    for (const r of sem.results ?? []) {
      const o = r as Record<string, any>;
      findings.push({
        category: `SAST: ${o.check_id ?? "semgrep"}`,
        filePath: String(o.path ?? "unknown").replace(/^pkg\/src\//, ""),
        lineNumber: Number(o.start?.line ?? 0) || 0,
        severity: mapSemgrepSeverity(o.extra?.severity ?? ""),
        codeSnippet: String(o.extra?.lines ?? "").slice(0, 1000),
      });
    }
  } catch {
    /* ignore malformed semgrep output */
  }

  // Gitleaks findings (array) — secrets are CRITICAL.
  try {
    const gl = JSON.parse(gitleaksJson) as unknown[];
    for (const r of Array.isArray(gl) ? gl : []) {
      const o = r as Record<string, any>;
      findings.push({
        category: `Secret: ${o.RuleID ?? o.Description ?? "gitleaks"}`,
        filePath: String(o.File ?? "unknown").replace(/^pkg\/src\//, ""),
        lineNumber: Number(o.StartLine ?? 0) || 0,
        severity: "CRITICAL",
        codeSnippet: String(o.Match ?? o.Secret ?? "").slice(0, 1000),
      });
    }
  } catch {
    /* ignore malformed gitleaks output */
  }

  // Risk score: weighted by severity, capped at 100. Zero findings → 0.
  const weight: Record<Severity, number> = { LOW: 8, MEDIUM: 20, HIGH: 40, CRITICAL: 60 };
  const raw = findings.reduce((sum, f) => sum + weight[f.severity], 0);
  const riskScore = Math.min(100, raw);
  return { findings, riskScore };
}

/** Map Opsera's report files (semgrep/gitleaks JSON) → findings + risk score. */
export function findingsFromReportFiles(
  files: Record<string, string>,
): { findings: Finding[]; riskScore: number } {
  // Find the semgrep + gitleaks report contents by filename heuristics.
  let semgrepJson = '{"results":[]}';
  let gitleaksJson = "[]";
  for (const [name, content] of Object.entries(files)) {
    const lower = name.toLowerCase();
    if (lower.includes("semgrep")) semgrepJson = content || semgrepJson;
    else if (lower.includes("gitleaks")) gitleaksJson = content || gitleaksJson;
  }
  // If Opsera wrote a single normalized report.json, prefer its findings.
  const normalized = files["report.json"] ?? files[".packguard/report.json"];
  if (normalized) {
    try {
      const parsed = JSON.parse(normalized) as { findings?: Finding[]; riskScore?: number };
      if (Array.isArray(parsed.findings)) {
        const score =
          typeof parsed.riskScore === "number"
            ? parsed.riskScore
            : scoreFromFindings(parsed.findings);
        return { findings: parsed.findings, riskScore: score };
      }
    } catch {
      /* fall through to scanner parsing */
    }
  }
  return findingsFromScanners(semgrepJson, gitleaksJson);
}

/** Weighted risk score from a findings list (shared with the scanner path). */
export function scoreFromFindings(findings: Finding[]): number {
  const weight: Record<Severity, number> = { LOW: 8, MEDIUM: 20, HIGH: 40, CRITICAL: 60 };
  const raw = findings.reduce((sum, f) => sum + (weight[f.severity] ?? 20), 0);
  return Math.min(100, raw);
}
export async function runAgenticScan(
  packageName: string,
  version: string,
  deps: OrchestratorDeps = {},
): Promise<OrchestratorResult> {
  const steps: ScanStep[] = [];
  const emit = (phase: ScanStep["phase"], message: string): void => {
    const step = { phase, message };
    steps.push(step);
    deps.onStep?.(step);
  };

  const nameCheck = validatePackageName(packageName);
  if (!nameCheck.valid) {
    emit("ERROR", `invalid package name: ${nameCheck.reason}`);
    return { ok: false, steps, error: nameCheck.reason };
  }

  const daytona = deps.daytona ?? new DaytonaClient();
  const storage = deps.storage ?? new TigrisStorageService();
  let sandboxId: string | undefined;

  try {
    emit("SANDBOX_CREATE", "Creating isolated Daytona sandbox…");
    sandboxId = await daytona.createSandbox();
    emit("SANDBOX_CREATE", `Sandbox ${sandboxId} ready.`);

    emit("FETCH", `Fetching ${packageName}@${version} in the sandbox (never installed)…`);
    emit("SCAN", "Running Opsera DevSecOps static scan (Semgrep + Gitleaks) in the sandbox…");
    const exec = await daytona.exec(sandboxId, buildScanScript(packageName, version), 300);
    if (exec.exitCode !== 0 && !exec.output.includes("<<<SEMGREP>>>")) {
      throw new Error(`sandbox scan failed (exit ${exec.exitCode}): ${exec.output.slice(-300)}`);
    }

    const semgrepJson = between(exec.output, "<<<SEMGREP>>>", "<<<ENDSEMGREP>>>") || '{"results":[]}';
    const gitleaksJson = between(exec.output, "<<<GITLEAKS>>>", "<<<ENDGITLEAKS>>>") || "[]";

    emit("NORMALIZE", "Normalizing findings and scoring risk…");
    const { findings, riskScore } = findingsFromScanners(semgrepJson, gitleaksJson);
    const normalized = normalizeReport(
      { packageName, version, riskScore, findings },
      deps.threshold !== undefined ? { threshold: deps.threshold } : {},
    );
    if (!normalized.ok) {
      throw new Error(`normalize failed: ${normalized.message}`);
    }
    const report: ReportSchema = { ...normalized.report, packageName, version };

    emit("STORE", "Storing report + source snapshot in Tigris…");
    const reportBytes = Buffer.from(JSON.stringify(report), "utf8");
    // Pull a small source snapshot from the sandbox for provenance.
    let sourceSnapshot = Buffer.from(`source:${packageName}@${version}`);
    try {
      const snap = await daytona.exec(
        sandboxId,
        "cd /tmp/pkg && tar -czf - src 2>/dev/null | base64 -w0",
        120,
      );
      const b64 = snap.output.trim().split("\n").pop() ?? "";
      if (b64.length > 0) sourceSnapshot = Buffer.from(b64, "base64");
    } catch {
      /* snapshot is best-effort */
    }

    const { scanRecord } = await storage.uploadScan({ report, reportBytes, sourceSnapshot });
    emit("DONE", `Verdict: ${report.verdict} (risk ${report.riskScore}). Stored in Tigris.`);

    return { ok: true, scanRecord, report, sandboxId, steps };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit("ERROR", message);
    return { ok: false, steps, sandboxId, error: message };
  } finally {
    if (sandboxId) {
      emit("CLEANUP", "Deleting the sandbox…");
      await daytona.deleteSandbox(sandboxId);
    }
  }
}

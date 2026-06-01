/**
 * Daytona sandbox client (Person C → productionized).
 *
 * Drives the Daytona REST API to run PackGuard's untrusted work inside an
 * ISOLATED cloud sandbox, so fetched npm source and the security scanners never
 * touch the host or the Vercel function. This is the "inspect without
 * installing, in isolation" guarantee, executed agentically (no human step).
 *
 * Flow per scan:
 *   1. create (or reuse) a sandbox
 *   2. exec: download the .tgz + safe-untar (no `npm install`, no code run)
 *   3. exec: install + run the static scanners (Semgrep + Gitleaks) — the
 *      Opsera DevSecOps scan compute, run in the sandbox
 *   4. read the raw scanner reports back out
 *   5. (caller) delete the sandbox
 *
 * Auth: Bearer `DAYTONA_API_KEY`. Base URL `DAYTONA_API_URL`
 * (default https://app.daytona.io/api).
 */

const DEFAULT_API_URL = "https://app.daytona.io/api";

/**
 * The workspace folder INSIDE the sandbox that both Vercel and the operator's
 * VS Code agree on. Vercel stages the package source under
 * `${SANDBOX_SCAN_DIR}/package`; the operator opens `${SANDBOX_SCAN_DIR}` in
 * VS Code Remote-SSH and runs the Opsera scan there, which writes
 * `*-report.json` files into `${SANDBOX_SCAN_DIR}`. Vercel then polls for them.
 */
export const SANDBOX_SCAN_DIR = "/home/daytona/scan-target";

export interface DaytonaConfig {
  apiKey: string;
  apiUrl?: string;
}

export interface ExecResult {
  exitCode: number;
  output: string;
}

export class DaytonaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaytonaError";
  }
}

export class DaytonaClient {
  private readonly apiKey: string;
  private readonly base: string;

  constructor(config?: DaytonaConfig) {
    this.apiKey = config?.apiKey ?? process.env["DAYTONA_API_KEY"] ?? "";
    this.base = (config?.apiUrl ?? process.env["DAYTONA_API_URL"] ?? DEFAULT_API_URL).replace(
      /\/+$/,
      "",
    );
    if (this.apiKey === "") {
      throw new DaytonaError("DAYTONA_API_KEY is not set");
    }
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  /** Create a sandbox and return its id. */
  async createSandbox(): Promise<string> {
    const res = await fetch(`${this.base}/sandbox`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ language: "typescript" }),
    });
    if (!res.ok) {
      throw new DaytonaError(`create sandbox failed: ${res.status} ${await safeText(res)}`);
    }
    const body = (await res.json()) as { id?: string };
    if (!body.id) throw new DaytonaError("create sandbox returned no id");
    return body.id;
  }

  /** Run a shell command inside the sandbox; returns exit code + combined output. */
  async exec(sandboxId: string, command: string, timeoutSec = 180): Promise<ExecResult> {
    const res = await fetch(
      `${this.base}/toolbox/${sandboxId}/toolbox/process/execute`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ command, timeout: timeoutSec }),
      },
    );
    if (!res.ok) {
      throw new DaytonaError(`exec failed: ${res.status} ${await safeText(res)}`);
    }
    const body = (await res.json()) as { exitCode?: number; result?: string };
    return { exitCode: body.exitCode ?? 0, output: body.result ?? "" };
  }

  /** Delete a sandbox (best-effort cleanup). */
  async deleteSandbox(sandboxId: string): Promise<void> {
    try {
      await fetch(`${this.base}/sandbox/${sandboxId}?force=true`, {
        method: "DELETE",
        headers: this.headers(),
      });
    } catch {
      // best-effort
    }
  }

  /** Verify a sandbox exists and is usable; returns its state, or null. */
  async getSandboxState(sandboxId: string): Promise<string | null> {
    try {
      const res = await fetch(`${this.base}/sandbox/${sandboxId}`, {
        headers: this.headers(),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { state?: string };
      return body.state ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Stage a package INTO an existing sandbox (the one VS Code is connected to):
   * download the resolved tarball and safe-untar it under
   * `${SANDBOX_SCAN_DIR}/package`. Never installs or runs the package. Also
   * clears any previous report files so polling can't read a stale scan.
   */
  async stagePackage(
    sandboxId: string,
    packageName: string,
    version: string,
  ): Promise<ExecResult> {
    const spec = `${packageName}@${version}`.replace(/'/g, "'\\''");
    const dir = SANDBOX_SCAN_DIR;
    const script = [
      `mkdir -p '${dir}'`,
      `cd '${dir}'`,
      // wipe previous package + reports so a new scan starts clean
      `rm -rf package *-report.json .packguard 2>/dev/null || true`,
      `URL=$(npm view '${spec}' dist.tarball 2>/dev/null | tail -1)`,
      `if [ -z "$URL" ]; then echo "RESOLVE_FAILED"; exit 7; fi`,
      `curl -sL "$URL" -o /tmp/pkg.tgz`,
      `mkdir -p package && tar -xzf /tmp/pkg.tgz -C package 2>/dev/null || true`,
      `echo "STAGED:$(find package -type f | wc -l) files in ${dir}/package"`,
    ].join("\n");
    return this.exec(sandboxId, script, 120);
  }

  /**
   * Poll the sandbox for Opsera scan output. Reads any `*-report.json` the scan
   * wrote into `${SANDBOX_SCAN_DIR}` and returns them as raw text keyed by
   * filename. Empty object means the scan hasn't produced reports yet.
   */
  async readReports(sandboxId: string): Promise<Record<string, string>> {
    const dir = SANDBOX_SCAN_DIR;
    // Emit each report file between sentinels we can split on.
    const script = [
      `cd '${dir}' 2>/dev/null || exit 0`,
      `for f in *-report.json semgrep*.json gitleaks*.json .packguard/report.json; do`,
      `  if [ -f "$f" ]; then echo "<<<FILE:$f>>>"; cat "$f"; echo "<<<ENDFILE>>>"; fi`,
      `done`,
    ].join("\n");
    const res = await this.exec(sandboxId, script, 60);
    return parseReportFiles(res.output);
  }
}

/** Split sentinel-delimited file output from {@link DaytonaClient.readReports}. */
export function parseReportFiles(output: string): Record<string, string> {
  const files: Record<string, string> = {};
  const re = /<<<FILE:(.+?)>>>([\s\S]*?)<<<ENDFILE>>>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    const name = (m[1] ?? "").trim();
    const content = (m[2] ?? "").trim();
    if (name) files[name] = content;
  }
  return files;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}

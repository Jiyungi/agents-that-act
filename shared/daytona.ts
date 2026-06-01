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
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}

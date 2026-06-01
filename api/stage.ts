/**
 * Vercel serverless function `POST /api/stage` (operator-sandbox flow).
 *
 * Stages an npm package INTO the Daytona sandbox the operator's VS Code is
 * connected to, so they can run the Opsera scan on it. Vercel does the fetch +
 * safe-untar via the Daytona REST API (same sandbox ID = same box VS Code sees).
 *
 *   POST /api/stage  body: { sandboxId: string, packageName: string, version?: string }
 *     200 { sandboxId, packageName, version, scanDir, message }
 *     400 { error }    (missing/invalid input)
 *     404 { error }    (sandbox not found, or version unresolved)
 *     502 { error }    (staging failed inside the sandbox)
 *
 * After a 200, the operator runs the Opsera security scan in Copilot on the
 * scan-target folder; the UI then polls `/api/poll` for the result.
 */

import { DaytonaClient, SANDBOX_SCAN_DIR } from "../shared/daytona.js";
import { validatePackageName } from "../shared/package-name.js";

export const config = { maxDuration: 120 };

export interface StageRequest {
  method?: string | undefined;
  body?: unknown;
  query?: Record<string, string | string[] | undefined> | undefined;
}
export interface StageResponse {
  status(code: number): StageResponse;
  json(payload: unknown): unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

async function latestVersion(packageName: string): Promise<string | null> {
  try {
    const seg = packageName.replace(/\//g, "%2f");
    const res = await fetch(`https://registry.npmjs.org/${seg}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const meta = (await res.json()) as { "dist-tags"?: { latest?: string } };
    return meta["dist-tags"]?.latest ?? null;
  } catch {
    return null;
  }
}

export async function stageToHttp(
  req: StageRequest,
): Promise<{ status: number; body: unknown }> {
  const body = asRecord(req.body) ?? {};
  const sandboxId =
    typeof body["sandboxId"] === "string" ? (body["sandboxId"] as string).trim() : "";
  const packageName =
    typeof body["packageName"] === "string" ? (body["packageName"] as string).trim() : "";
  const versionIn =
    typeof body["version"] === "string" ? (body["version"] as string).trim() : "";

  if (sandboxId === "") return { status: 400, body: { error: "sandboxId is required" } };
  const nameCheck = validatePackageName(packageName);
  if (!nameCheck.valid) return { status: 400, body: { error: nameCheck.reason } };

  const daytona = new DaytonaClient();
  const state = await daytona.getSandboxState(sandboxId);
  if (state === null) {
    return { status: 404, body: { error: `sandbox ${sandboxId} not found or not accessible` } };
  }

  const version = versionIn !== "" ? versionIn : await latestVersion(packageName);
  if (!version) {
    return { status: 404, body: { error: `could not resolve a version for ${packageName}` } };
  }

  const result = await daytona.stagePackage(sandboxId, packageName, version);
  if (result.output.includes("RESOLVE_FAILED")) {
    return { status: 404, body: { error: `npm could not resolve ${packageName}@${version}` } };
  }
  if (result.exitCode !== 0 && !result.output.includes("STAGED:")) {
    return {
      status: 502,
      body: { error: `staging failed: ${result.output.slice(-300)}` },
    };
  }

  return {
    status: 200,
    body: {
      sandboxId,
      packageName,
      version,
      scanDir: SANDBOX_SCAN_DIR,
      message: `Staged ${packageName}@${version} in the sandbox. In VS Code Copilot, run a security scan on ${SANDBOX_SCAN_DIR}.`,
    },
  };
}

export default async function handler(req: StageRequest, res: StageResponse): Promise<void> {
  const { status, body } = await stageToHttp(req);
  res.status(status).json(body);
}

/**
 * Vercel serverless function `POST /api/scan` — the AGENTIC scan endpoint.
 *
 * One call runs the whole pipeline with NO human step:
 *   Daytona  → isolated sandbox: fetch + safe-untar the npm package
 *   Opsera   → static security scan (Semgrep + Gitleaks) inside the sandbox
 *   Tigris   → store report + source snapshot + Scan_Record (gallery updates)
 *
 *   POST /api/scan   body: { packageName: string, version?: string }
 *     200 { scanRecord, report, steps }
 *     400 { error }            (invalid/missing package name)
 *     502 { error, steps }     (sandbox/scan/storage failure)
 *
 * NOTE: the Daytona sandbox scan takes ~60–90s, so this function needs a raised
 * maxDuration (see `config` below). On the hobby tier this is capped at 60s; if
 * the function times out, run the same pipeline locally via
 * `npx tsx scripts/verify-agentic.ts <pkg> <version>` (identical code path).
 */

import { runAgenticScan } from "../shared/orchestrator.js";

/** Raise the serverless timeout for the long Daytona scan (Pro tier: up to 300). */
export const config = { maxDuration: 300 };

export interface ScanRequest {
  method?: string | undefined;
  body?: unknown;
  query?: Record<string, string | string[] | undefined> | undefined;
}

export interface ScanResponse {
  status(code: number): ScanResponse;
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

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function scanToHttp(
  req: ScanRequest,
): Promise<{ status: number; body: unknown }> {
  const body = asRecord(req.body);
  const packageName =
    (typeof body?.["packageName"] === "string" ? (body["packageName"] as string) : undefined) ??
    firstParam(req.query?.["packageName"]);
  const version =
    (typeof body?.["version"] === "string" ? (body["version"] as string) : undefined) ??
    firstParam(req.query?.["version"]);

  if (!packageName || packageName.trim() === "") {
    return { status: 400, body: { error: "packageName is required" } };
  }

  // Resolve "latest" when no version is given, using the npm registry, so the
  // sandbox pins an exact version (and the Tigris key is stable).
  const resolvedVersion = version && version.trim() !== "" ? version.trim() : await latestVersion(packageName);
  if (!resolvedVersion) {
    return { status: 404, body: { error: `could not resolve a version for ${packageName}` } };
  }

  const result = await runAgenticScan(packageName.trim(), resolvedVersion);
  if (!result.ok) {
    return { status: 502, body: { error: result.error, steps: result.steps } };
  }
  return {
    status: 200,
    body: { scanRecord: result.scanRecord, report: result.report, steps: result.steps },
  };
}

/** Resolve the latest published version from the npm registry. */
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

export default async function handler(req: ScanRequest, res: ScanResponse): Promise<void> {
  const { status, body } = await scanToHttp(req);
  res.status(status).json(body);
}

/**
 * Vercel serverless function `GET /api/poll` (operator-sandbox flow).
 *
 * After the operator runs the Opsera security scan in their VS Code Copilot
 * (inside the Daytona sandbox), this endpoint reads the report files Opsera
 * wrote into the sandbox, normalizes them to the shared Report_Schema, scores
 * the verdict, and — on first sight — stores everything in Tigris so the
 * gallery updates ON ITS OWN. The UI polls this until `ready` is true.
 *
 *   GET /api/poll?sandboxId=…&packageName=…&version=…
 *     200 { ready: false }                         (scan not done yet)
 *     200 { ready: true, scanRecord, report }       (scan done → stored in Tigris)
 *     400 { error }                                 (missing params)
 *     404 { error }                                 (sandbox not found)
 *
 * Idempotent: re-polling after storage just re-reads the Tigris record.
 */

import { DaytonaClient } from "../shared/daytona.js";
import { findingsFromReportFiles } from "../shared/orchestrator.js";
import { normalizeReport } from "../shared/normalize.js";
import { TigrisStorageService } from "../shared/storage.js";
import type { ReportSchema } from "../shared/report.js";

export const config = { maxDuration: 60 };

export interface PollRequest {
  method?: string | undefined;
  query?: Record<string, string | string[] | undefined> | undefined;
}
export interface PollResponse {
  status(code: number): PollResponse;
  json(payload: unknown): unknown;
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function pollToHttp(
  req: PollRequest,
): Promise<{ status: number; body: unknown }> {
  const sandboxId = firstParam(req.query?.["sandboxId"])?.trim() ?? "";
  const packageName = firstParam(req.query?.["packageName"])?.trim() ?? "";
  const version = firstParam(req.query?.["version"])?.trim() ?? "";

  if (sandboxId === "" || packageName === "" || version === "") {
    return { status: 400, body: { error: "sandboxId, packageName and version are required" } };
  }

  const storage = new TigrisStorageService();

  // If we already stored this scan (operator may have polled before), short-circuit.
  const existing = await storage.getReport(packageName, version);
  if (existing) {
    const record = await storage.getPublicReportUrl(packageName, version);
    return {
      status: 200,
      body: { ready: true, report: existing, publicReportUrl: record, stored: true },
    };
  }

  const daytona = new DaytonaClient();
  const state = await daytona.getSandboxState(sandboxId);
  if (state === null) {
    return { status: 404, body: { error: `sandbox ${sandboxId} not found` } };
  }

  const files = await daytona.readReports(sandboxId);
  if (Object.keys(files).length === 0) {
    // Opsera hasn't written reports yet — keep polling.
    return { status: 200, body: { ready: false } };
  }

  // Reports present → normalize, score, store in Tigris.
  const { findings, riskScore } = findingsFromReportFiles(files);
  const normalized = normalizeReport({ packageName, version, riskScore, findings });
  if (!normalized.ok) {
    return { status: 502, body: { error: `normalize failed: ${normalized.message}` } };
  }
  const report: ReportSchema = { ...normalized.report, packageName, version };
  const reportBytes = Buffer.from(JSON.stringify(report), "utf8");

  // Pull a source snapshot for provenance (best-effort).
  let sourceSnapshot = Buffer.from(`source:${packageName}@${version}`);
  try {
    const snap = await daytona.exec(
      sandboxId,
      "cd /home/daytona/scan-target && tar -czf - package 2>/dev/null | base64 -w0",
      90,
    );
    const b64 = snap.output.trim().split("\n").pop() ?? "";
    if (b64.length > 0) sourceSnapshot = Buffer.from(b64, "base64");
  } catch {
    /* snapshot optional */
  }

  const { scanRecord } = await storage.uploadScan({ report, reportBytes, sourceSnapshot });
  return { status: 200, body: { ready: true, scanRecord, report, stored: true } };
}

export default async function handler(req: PollRequest, res: PollResponse): Promise<void> {
  const { status, body } = await pollToHttp(req);
  res.status(status).json(body);
}

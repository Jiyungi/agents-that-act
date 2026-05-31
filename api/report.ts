/**
 * Vercel serverless function `GET /api/report` (Person B, Reqs 8.3, 11).
 *
 * Serves a stored, normalized {@link ReportSchema} for a package+version so the
 * Frontend_UI's verdict card can render findings + code lines. This is the
 * same-origin Public_Report_URL target minted by the Storage_Service when no
 * external public Tigris domain is configured, and it requires no
 * authentication (Req 8.3).
 *
 *   GET /api/report?packageName=<name>&version=<version>
 *     200 ReportSchema
 *     400 { error } when params are missing
 *     404 { error } when no stored report matches (Req 8.4)
 */

import type { ReportSchema } from "@shared/report";
import { getStorage } from "./_lib/storage.js";

export interface ReportRequest {
  method?: string | undefined;
  query?: Record<string, string | string[] | undefined> | undefined;
}

export interface ReportResponse {
  status(code: number): ReportResponse;
  json(payload: unknown): unknown;
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function reportToHttp(
  req: ReportRequest,
): Promise<{ status: number; body: ReportSchema | { error: string } }> {
  const packageName = firstParam(req.query?.["packageName"]);
  const version = firstParam(req.query?.["version"]);
  if (!packageName || !version) {
    return {
      status: 400,
      body: { error: "packageName and version query params are required" },
    };
  }

  const report = await getStorage().getReport(packageName, version);
  if (report === null) {
    return { status: 404, body: { error: "no stored report for that package/version" } };
  }
  return { status: 200, body: report };
}

export default async function handler(
  req: ReportRequest,
  res: ReportResponse,
): Promise<void> {
  const { status, body } = await reportToHttp(req);
  res.status(status).json(body);
}

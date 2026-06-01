/**
 * Manual smoke test: full agent flow against REAL npm + REAL Tigris.
 *   fetch left-pad → write a fake Opsera report to reportPath → upload.
 * Run: npx tsx scripts/smoke-agent.ts   (agent must NOT already be running on 3939)
 */
import * as fs from "node:fs/promises";
import { loadRepoEnv } from "../shared/env.js";
loadRepoEnv();

const AGENT = "http://127.0.0.1:3939";

async function main(): Promise<void> {
  // 1) fetch + extract left-pad.
  const fetchRes = await fetch(`${AGENT}/local/fetch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      packageName: "left-pad",
      version: "1.3.0",
      tarballUrl: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
    }),
  });
  const fetchBody = (await fetchRes.json()) as Record<string, any>;
  console.log("fetch status:", fetchRes.status);
  console.log("fetch body:", JSON.stringify(fetchBody, null, 2));

  // The contract + uploadId are present on success (200) OR on a VS Code
  // failure (503/500, scan-target retained).
  const uploadId = fetchBody["uploadId"] as string | undefined;
  const reportPath = (fetchBody["reportPath"] ?? fetchBody["contract"]?.reportPath) as
    | string
    | undefined;
  if (!uploadId || !reportPath) {
    throw new Error("no uploadId/reportPath returned — cannot continue");
  }

  // 2) Simulate the manual Opsera scan: write a report at reportPath.
  const report = {
    packageName: "left-pad",
    version: "1.3.0",
    riskScore: 5,
    findings: [],
  };
  await fs.writeFile(reportPath, JSON.stringify(report), "utf8");
  console.log("wrote fake report to", reportPath);

  // 3) Upload trigger → normalize → Tigris.
  const upRes = await fetch(`${AGENT}/local/upload`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uploadId }),
  });
  const upBody = (await upRes.json()) as Record<string, any>;
  console.log("upload status:", upRes.status);
  console.log("upload body:", JSON.stringify(upBody, null, 2));
}

main().catch((e) => {
  console.error("AGENT SMOKE FAILED:", e);
  process.exitCode = 1;
});

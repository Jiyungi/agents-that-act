/**
 * Manual smoke test: round-trip a scan through the REAL Tigris Storage_Service.
 * Run: npx tsx scripts/smoke-tigris.ts
 * Not a vitest test — it talks to the live bucket using repo-root .env creds.
 */
import { loadRepoEnv } from "../shared/env.js";
loadRepoEnv();

import { TigrisStorageService } from "../shared/storage.js";
import { normalizeReport } from "../shared/normalize.js";

async function main(): Promise<void> {
  const storage = new TigrisStorageService();

  const raw = {
    packageName: "smoke-test-pkg",
    version: "0.0.1",
    riskScore: 12,
    findings: [
      { category: "test-finding", filePath: "index.js", lineNumber: 3, severity: "LOW", codeSnippet: "const x = 1;" },
    ],
  };
  const normalized = normalizeReport(raw);
  if (!normalized.ok) throw new Error("normalize failed: " + normalized.message);
  // upload trigger overrides identity from the contract; mimic that here.
  const report = { ...normalized.report, packageName: "smoke-test-pkg", version: "0.0.1" };

  console.log("uploading…", report.verdict, report.riskScore);
  const { scanRecord } = await storage.uploadScan({
    report,
    reportBytes: Buffer.from(JSON.stringify(report)),
    sourceSnapshot: Buffer.from("fake-tgz-bytes"),
  });
  console.log("scanRecord:", JSON.stringify(scanRecord, null, 2));

  const gallery = await storage.listScans();
  console.log("gallery count:", gallery.records.length, "unavailable:", gallery.unavailable);

  const fetched = await storage.getReport("smoke-test-pkg", "0.0.1");
  console.log("fetched report verdict:", fetched?.verdict, "findings:", fetched?.findings.length);
}

main().catch((e) => {
  console.error("SMOKE FAILED:", e);
  process.exitCode = 1;
});

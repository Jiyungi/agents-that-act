/**
 * Verify the full agentic pipeline end-to-end: Daytona -> Opsera scan -> Tigris.
 * Run: npx tsx scripts/verify-agentic.ts <pkg> <version>
 */
import { loadRepoEnv } from "../shared/env.js";
loadRepoEnv();

import { runAgenticScan } from "../shared/orchestrator.js";

const pkg = process.argv[2] ?? "left-pad";
const version = process.argv[3] ?? "1.3.0";

const result = await runAgenticScan(pkg, version, {
  onStep: (s) => console.log(`[${s.phase}] ${s.message}`),
});

console.log("\n=== RESULT ===");
console.log("ok:", result.ok);
if (result.scanRecord) {
  console.log("verdict:", result.scanRecord.verdict, "score:", result.scanRecord.riskScore);
  console.log("publicReportUrl:", result.scanRecord.publicReportUrl);
}
if (result.report) {
  console.log("findings:", result.report.findings.length);
}
if (result.error) console.log("error:", result.error);
process.exit(result.ok ? 0 : 1);

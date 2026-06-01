/**
 * Verify the operator-sandbox flow plumbing end-to-end (no VS Code needed):
 *   create sandbox -> /api/stage logic -> simulate Opsera writing reports ->
 *   /api/poll logic -> Tigris.
 * Run: npx tsx scripts/verify-sandbox-flow.ts
 */
import { loadRepoEnv } from "../shared/env.js";
loadRepoEnv();

import { DaytonaClient, SANDBOX_SCAN_DIR } from "../shared/daytona.js";
import { findingsFromReportFiles } from "../shared/orchestrator.js";
import { normalizeReport } from "../shared/normalize.js";
import { TigrisStorageService } from "../shared/storage.js";

const pkg = process.argv[2] ?? "left-pad";
const version = process.argv[3] ?? "1.3.0";

const d = new DaytonaClient();
let sid = "";
try {
  console.log("creating sandbox…");
  sid = await d.createSandbox();
  console.log("sandbox:", sid, "state:", await d.getSandboxState(sid));

  console.log("staging package (Vercel /api/stage does this)…");
  const staged = await d.stagePackage(sid, pkg, version);
  console.log("stage output:", staged.output.trim().split("\n").pop());

  // Simulate the operator's Opsera scan writing report files into the scan dir.
  console.log("simulating Opsera scan output in the sandbox…");
  const semgrep = JSON.stringify({
    results: [
      {
        check_id: "javascript.lang.security.eval",
        path: "package/index.js",
        start: { line: 5 },
        extra: { severity: "ERROR", lines: "eval(userInput)" },
      },
    ],
  });
  const writeCmd = `cd ${SANDBOX_SCAN_DIR} && cat > semgrep-report.json <<'EOF'\n${semgrep}\nEOF\necho '[]' > gitleaks-report.json && echo WROTE`;
  const w = await d.exec(sid, writeCmd, 60);
  console.log("write reports:", w.output.trim().split("\n").pop());

  console.log("polling for reports (Vercel /api/poll does this)…");
  const files = await d.readReports(sid);
  console.log("found report files:", Object.keys(files));

  const { findings, riskScore } = findingsFromReportFiles(files);
  const norm = normalizeReport({ packageName: pkg, version, riskScore, findings });
  if (!norm.ok) throw new Error("normalize failed: " + norm.message);
  const report = { ...norm.report, packageName: pkg, version };
  console.log("normalized:", report.verdict, "score", report.riskScore, "findings", report.findings.length);

  const storage = new TigrisStorageService();
  const { scanRecord } = await storage.uploadScan({
    report,
    reportBytes: Buffer.from(JSON.stringify(report)),
    sourceSnapshot: Buffer.from("snap"),
  });
  console.log("STORED IN TIGRIS:", scanRecord.verdict, scanRecord.publicReportUrl);
} catch (e) {
  console.error("FAILED:", e);
  process.exitCode = 1;
} finally {
  if (sid) {
    console.log("deleting sandbox…");
    await d.deleteSandbox(sid);
  }
}

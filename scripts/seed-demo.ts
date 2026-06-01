/**
 * Seed the Tigris gallery with clean demo records for a live demo.
 * Run: npx tsx scripts/seed-demo.ts
 *
 * SAFE: left-pad (genuinely clean, real package).
 * RISKY: a clearly demo-labelled package showing what a RISKY verdict + real
 *        static-analysis findings look like (hardcoded secret + eval usage).
 *
 * This is "inspect without installing"-safe: it only WRITES report JSON to
 * Tigris. No package code is fetched or executed.
 */
import { loadRepoEnv } from "../shared/env.js";
loadRepoEnv();

import { TigrisStorageService } from "../shared/storage.js";
import { normalizeReport } from "../shared/normalize.js";

const storage = new TigrisStorageService();

async function seed(raw: Record<string, unknown>, name: string, version: string): Promise<void> {
  const n = normalizeReport(raw);
  if (!n.ok) throw new Error(`normalize failed for ${name}: ${n.message}`);
  const report = { ...n.report, packageName: name, version };
  const { scanRecord } = await storage.uploadScan({
    report,
    reportBytes: Buffer.from(JSON.stringify(report)),
    sourceSnapshot: Buffer.from(`source-snapshot:${name}@${version}`),
  });
  console.log(`seeded ${name}@${version} -> ${scanRecord.verdict} (score ${scanRecord.riskScore})`);
}

async function main(): Promise<void> {
  // Clean up leftover test artifacts so the gallery looks polished.
  for (const stale of [["smoke-test-pkg", "0.0.1"], ["is-odd", "3.0.1"], ["pad-left", "2.1.0"], ["is-even", "1.0.0"], ["demo-eval-pkg", "1.0.0"]]) {
    await storage.deleteScan(stale[0]!, stale[1]!);
    console.log(`removed stale ${stale[0]}@${stale[1]}`);
  }

  // SAFE — genuinely clean utility package, zero findings.
  await seed(
    { packageName: "left-pad", version: "1.3.0", riskScore: 3, findings: [] },
    "left-pad",
    "1.3.0",
  );

  // RISKY — demo-labelled package with realistic static-analysis findings.
  await seed(
    {
      packageName: "demo-risky-pkg",
      version: "1.0.0",
      riskScore: 87,
      findings: [
        {
          category: "Hardcoded credential (Gitleaks)",
          filePath: "src/config.js",
          lineNumber: 12,
          severity: "CRITICAL",
          codeSnippet: 'const AWS_SECRET = "AKIA................EXAMPLE";',
        },
        {
          category: "Use of eval (Semgrep)",
          filePath: "src/loader.js",
          lineNumber: 47,
          severity: "HIGH",
          codeSnippet: "return eval(decode(payload));",
        },
        {
          category: "Insecure child_process (Semgrep)",
          filePath: "src/run.js",
          lineNumber: 8,
          severity: "MEDIUM",
          codeSnippet: "exec(`curl ${userInput} | sh`);",
        },
      ],
    },
    "demo-risky-pkg",
    "1.0.0",
  );

  const gallery = await storage.listScans();
  console.log(`\ngallery now has ${gallery.records.length} records:`);
  for (const r of gallery.records) {
    console.log(`  - ${r.packageName}@${r.version}  ${r.verdict}  (${r.riskScore})`);
  }
}

main().catch((e) => {
  console.error("SEED FAILED:", e);
  process.exitCode = 1;
});

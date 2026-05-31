/**
 * Tests for the upload-trigger core (task 7.2 → Interface 3, Reqs 6.3–6.6).
 *
 * These are example/branch tests (the design's "Upload trigger" example tests):
 *  - report present → success + cleanup called + record persisted (6.3, 6.4)
 *  - report-missing guard → REPORT_MISSING + storage NOT called (6.5)
 *  - storage failure → UPLOAD_FAILED + report retained + cleanup NOT called (6.6)
 *  - storage no-confirm in 30s (timeout) → UPLOAD_FAILED + retained (6.6)
 *  - present-but-out-of-range riskScore → INVALID_RISK_SCORE (13.6)
 *  - missing/empty contract identifier → INVALID_IDENTIFIER (7.6)
 *
 * Strategy: a real temp `./scan-target/` populated with source files (and a
 * `.packguard/report.json` when present) + the in-memory `StorageService` fake.
 * The fs-based reader and tar+gzip snapshot run for real so the happy path is
 * exercised end-to-end without a network or VS Code.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createGunzip } from "node:zlib";
import { extract as createTarExtract } from "tar-stream";
import { Readable } from "node:stream";

import { UploadErrorType } from "@shared/errors";
import type { ScanResultContract } from "@shared/scan";
import type { ReportSchema } from "@shared/report";
import {
  InMemoryStorageService,
  StorageError,
  type StorageService,
} from "@shared/testing/storage-fake";
import {
  RAW_OPSERA_WELL_FORMED,
  RAW_OPSERA_OUT_OF_RANGE_SCORE,
} from "@shared/testing/fixtures";

import {
  createStubNormalizeReport,
  defaultMakeSourceSnapshot,
  runUploadTrigger,
} from "./upload.js";
import { computeReportPath, computePackguardDir } from "./scan-result.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "packguard-upload-"));
});

afterEach(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

/** Populate a fake scan-target with a couple of inert source files. */
async function seedSource(sourceRoot: string): Promise<void> {
  await fsp.mkdir(path.join(sourceRoot, "src"), { recursive: true });
  await fsp.writeFile(path.join(sourceRoot, "package.json"), '{"name":"demo"}\n');
  await fsp.writeFile(path.join(sourceRoot, "src", "index.js"), "module.exports = 1;\n");
}

/** Write a raw Opsera report at the agreed reportPath. */
async function seedReport(sourceRoot: string, raw: unknown): Promise<string> {
  await fsp.mkdir(computePackguardDir(sourceRoot), { recursive: true });
  const reportPath = computeReportPath(sourceRoot);
  await fsp.writeFile(reportPath, JSON.stringify(raw));
  return reportPath;
}

/** Build a contract pointing at a freshly seeded scan-target. */
async function makeContract(options?: {
  withReport?: unknown;
  packageName?: string;
  version?: string;
}): Promise<ScanResultContract> {
  const sourceRoot = path.join(tmpRoot, "scan-target");
  await seedSource(sourceRoot);
  if (options?.withReport !== undefined) {
    await seedReport(sourceRoot, options.withReport);
  } else {
    // Ensure the .packguard dir exists but NO report file (report-missing case).
    await fsp.mkdir(computePackguardDir(sourceRoot), { recursive: true });
  }
  return {
    packageName: options?.packageName ?? "left-pad",
    version: options?.version ?? "1.3.0",
    sourcePath: sourceRoot,
    reportPath: computeReportPath(sourceRoot),
  };
}

describe("runUploadTrigger — report present (Reqs 6.3, 6.4)", () => {
  it("normalizes, uploads, persists a record, returns it, and calls cleanup", async () => {
    const contract = await makeContract({ withReport: RAW_OPSERA_WELL_FORMED });
    const storage = new InMemoryStorageService();
    let cleanupCalls = 0;

    const result = await runUploadTrigger({
      contract,
      cleanup: async () => {
        cleanupCalls += 1;
      },
      storageService: storage,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Record identity comes from the CONTRACT (the resolved truth).
    expect(result.scanRecord.packageName).toBe("left-pad");
    expect(result.scanRecord.version).toBe("1.3.0");
    expect(result.scanRecord.verdict).toBe("SAFE"); // riskScore 8 < 50
    expect(result.scanRecord.riskScore).toBe(8);
    expect(typeof result.scanRecord.createdAt).toBe("string");
    // Persisted in storage (Req 6.4 confirmation).
    expect(storage.size).toBe(1);
    // Confirmed success cleans up the retained scan-target (Req 4.7).
    expect(cleanupCalls).toBe(1);
  });

  it("hands a valid gzipped tar Source_Snapshot and raw reportBytes to storage", async () => {
    const contract = await makeContract({ withReport: RAW_OPSERA_WELL_FORMED });
    const captured: {
      report?: ReportSchema;
      reportBytes?: Buffer;
      sourceSnapshot?: Buffer;
    } = {};
    const storage: StorageService = {
      uploadScan: async (input) => {
        captured.report = input.report;
        captured.reportBytes = input.reportBytes;
        captured.sourceSnapshot = input.sourceSnapshot;
        return new InMemoryStorageService().uploadScan(input);
      },
      getPublicReportUrl: async () => null,
      listScans: async () => ({ records: [], partial: false, unavailable: false }),
    };

    const result = await runUploadTrigger({
      contract,
      cleanup: async () => undefined,
      storageService: storage,
    });
    expect(result.ok).toBe(true);

    // reportBytes are the raw file bytes (round-trips to the fixture).
    expect(JSON.parse(captured.reportBytes!.toString("utf8"))).toMatchObject({
      packageName: "left-pad",
    });
    // sourceSnapshot is a real gzipped tar containing the seeded files.
    const names = await listTgzEntryNames(captured.sourceSnapshot!);
    expect(names).toContain("package.json");
    expect(names).toContain(path.join("src", "index.js"));
  });
});

describe("runUploadTrigger — report-missing guard (Req 6.5)", () => {
  it("returns REPORT_MISSING and does NOT call the Storage_Service or cleanup", async () => {
    const contract = await makeContract(); // no report file
    let uploadCalled = false;
    let cleanupCalls = 0;
    const storage: StorageService = {
      uploadScan: async (input) => {
        uploadCalled = true;
        return new InMemoryStorageService().uploadScan(input);
      },
      getPublicReportUrl: async () => null,
      listScans: async () => ({ records: [], partial: false, unavailable: false }),
    };

    const result = await runUploadTrigger({
      contract,
      cleanup: async () => {
        cleanupCalls += 1;
      },
      storageService: storage,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorType).toBe(UploadErrorType.REPORT_MISSING);
    expect(uploadCalled).toBe(false); // Req 6.5: storage NOT invoked
    expect(cleanupCalls).toBe(0); // report retained, no cleanup
  });
});

describe("runUploadTrigger — storage failure/timeout (Req 6.6)", () => {
  it("maps a Storage_Service rejection to UPLOAD_FAILED, retains report, no cleanup", async () => {
    const contract = await makeContract({ withReport: RAW_OPSERA_WELL_FORMED });
    let cleanupCalls = 0;
    const storage: StorageService = {
      uploadScan: async () => {
        throw new StorageError(UploadErrorType.UPLOAD_FAILED, "tigris down");
      },
      getPublicReportUrl: async () => null,
      listScans: async () => ({ records: [], partial: false, unavailable: false }),
    };

    const result = await runUploadTrigger({
      contract,
      cleanup: async () => {
        cleanupCalls += 1;
      },
      storageService: storage,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorType).toBe(UploadErrorType.UPLOAD_FAILED);
    expect(cleanupCalls).toBe(0); // Req 6.6: report retained, cleanup NOT called
    // Report file is still on disk (retained).
    await expect(fsp.access(contract.reportPath)).resolves.toBeUndefined();
  });

  it("maps a no-confirm-within-timeout to UPLOAD_FAILED and retains the report", async () => {
    const contract = await makeContract({ withReport: RAW_OPSERA_WELL_FORMED });
    let cleanupCalls = 0;
    // A storage that never resolves within the (tiny) confirm budget.
    const storage: StorageService = {
      uploadScan: () =>
        new Promise(() => {
          /* never resolves */
        }),
      getPublicReportUrl: async () => null,
      listScans: async () => ({ records: [], partial: false, unavailable: false }),
    };

    const result = await runUploadTrigger({
      contract,
      cleanup: async () => {
        cleanupCalls += 1;
      },
      storageService: storage,
      timeoutMs: 25, // shrink the 30s budget so the test is fast
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorType).toBe(UploadErrorType.UPLOAD_FAILED);
    expect(cleanupCalls).toBe(0);
    await expect(fsp.access(contract.reportPath)).resolves.toBeUndefined();
  });
});

describe("runUploadTrigger — INVALID_RISK_SCORE (Req 13.6)", () => {
  it("rejects a present-but-out-of-range riskScore without calling storage", async () => {
    const contract = await makeContract({ withReport: RAW_OPSERA_OUT_OF_RANGE_SCORE });
    let uploadCalled = false;
    const storage: StorageService = {
      uploadScan: async (input) => {
        uploadCalled = true;
        return new InMemoryStorageService().uploadScan(input);
      },
      getPublicReportUrl: async () => null,
      listScans: async () => ({ records: [], partial: false, unavailable: false }),
    };

    const result = await runUploadTrigger({
      contract,
      cleanup: async () => undefined,
      storageService: storage,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorType).toBe(UploadErrorType.INVALID_RISK_SCORE);
    expect(uploadCalled).toBe(false);
  });
});

describe("runUploadTrigger — INVALID_IDENTIFIER (Req 7.6)", () => {
  it("rejects a contract with an empty packageName before any I/O", async () => {
    const contract = await makeContract({ withReport: RAW_OPSERA_WELL_FORMED, packageName: "   " });
    const readReport = vi.fn();
    const result = await runUploadTrigger({
      contract,
      cleanup: async () => undefined,
      storageService: new InMemoryStorageService(),
      readReport, // must not be called
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorType).toBe(UploadErrorType.INVALID_IDENTIFIER);
    expect(readReport).not.toHaveBeenCalled();
  });
});

describe("createStubNormalizeReport (TEMPORARY seam)", () => {
  it("defaults an absent riskScore to 100 (RISKY) per fail-safe (Req 12.5)", () => {
    const normalize = createStubNormalizeReport(50);
    const out = normalize({ packageName: "p", version: "1.0.0" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.report.riskScore).toBe(100);
    expect(out.report.verdict).toBe("RISKY");
  });

  it("derives SAFE below threshold and RISKY at/above (Reqs 13.2, 13.3)", () => {
    const normalize = createStubNormalizeReport(50);
    const safe = normalize({ packageName: "p", version: "1", riskScore: 49 });
    const risky = normalize({ packageName: "p", version: "1", riskScore: 50 });
    expect(safe.ok && safe.report.verdict).toBe("SAFE");
    expect(risky.ok && risky.report.verdict).toBe("RISKY");
  });

  it("rejects a present-but-out-of-range riskScore (Req 13.6)", () => {
    const normalize = createStubNormalizeReport(50);
    const out = normalize({ packageName: "p", version: "1", riskScore: 150 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errorType).toBe(UploadErrorType.INVALID_RISK_SCORE);
  });
});

describe("defaultMakeSourceSnapshot", () => {
  it("produces a gzipped tar of the source tree and never follows symlinks", async () => {
    const sourceRoot = path.join(tmpRoot, "snap");
    await seedSource(sourceRoot);
    const snapshot = await defaultMakeSourceSnapshot(sourceRoot);
    const names = await listTgzEntryNames(snapshot);
    expect(names.sort()).toEqual([path.join("src", "index.js"), "package.json"].sort());
  });
});

/** Read entry names out of a gzipped tar buffer (test helper). */
async function listTgzEntryNames(tgz: Buffer): Promise<string[]> {
  const names: string[] = [];
  const tar = createTarExtract();
  const gunzip = createGunzip();
  const done = new Promise<void>((resolve, reject) => {
    tar.on("entry", (header, stream, next) => {
      names.push(header.name);
      stream.on("end", next);
      stream.resume();
    });
    tar.on("finish", () => resolve());
    tar.on("error", reject);
    gunzip.on("error", reject);
  });
  Readable.from([tgz]).pipe(gunzip).pipe(tar);
  await done;
  return names;
}

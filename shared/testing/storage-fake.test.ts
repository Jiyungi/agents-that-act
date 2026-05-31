import { describe, expect, it } from "vitest";
import {
  GALLERY_MAX_RECORDS,
  InMemoryStorageService,
  StorageError,
  reportKeyFor,
  sourceKeyFor,
} from "@shared/testing/storage-fake";
import {
  makeFakeNormalizedReport,
} from "@shared/testing/agent-fake";
import { UploadErrorType } from "@shared/errors";

describe("InMemoryStorageService fake", () => {
  it("uploadScan then listScans returns the stored record", async () => {
    const storage = new InMemoryStorageService();
    const report = makeFakeNormalizedReport({
      packageName: "left-pad",
      version: "1.3.0",
      verdict: "SAFE",
      riskScore: 12,
    });

    const { scanRecord } = await storage.uploadScan({
      report,
      reportBytes: Buffer.from("{}"),
      sourceSnapshot: Buffer.from("tgz-bytes"),
    });

    // The returned record echoes the report identity and is complete.
    expect(scanRecord.packageName).toBe("left-pad");
    expect(scanRecord.version).toBe("1.3.0");
    expect(scanRecord.verdict).toBe("SAFE");
    expect(scanRecord.riskScore).toBe(12);
    expect(scanRecord.thresholdUsed).toBe(50);
    expect(scanRecord.reportKey).toBe(reportKeyFor("left-pad", "1.3.0"));
    expect(scanRecord.sourceKey).toBe(sourceKeyFor("left-pad", "1.3.0"));
    expect(scanRecord.publicReportUrl).toContain(scanRecord.reportKey);
    // createdAt is a valid UTC ISO-8601 timestamp.
    expect(scanRecord.createdAt).toBe(
      new Date(scanRecord.createdAt).toISOString(),
    );

    const gallery = await storage.listScans();
    expect(gallery.partial).toBe(false);
    expect(gallery.unavailable).toBe(false);
    expect(gallery.records).toHaveLength(1);
    expect(gallery.records[0]).toEqual(scanRecord);
  });

  it("getPublicReportUrl returns the minted URL after upload, null otherwise", async () => {
    const storage = new InMemoryStorageService();
    expect(await storage.getPublicReportUrl("left-pad", "1.3.0")).toBeNull();

    await storage.uploadScan({
      report: makeFakeNormalizedReport({ packageName: "left-pad", version: "1.3.0" }),
      reportBytes: Buffer.from("{}"),
      sourceSnapshot: Buffer.from("tgz"),
    });

    const url = await storage.getPublicReportUrl("left-pad", "1.3.0");
    expect(url).not.toBeNull();
    expect(url).toContain(reportKeyFor("left-pad", "1.3.0"));
  });

  it("persists publicReportUrl = null when minting is disabled (Req 8.2 fallback)", async () => {
    const storage = new InMemoryStorageService({ mintPublicUrl: false });
    const { scanRecord } = await storage.uploadScan({
      report: makeFakeNormalizedReport(),
      reportBytes: Buffer.from("{}"),
      sourceSnapshot: Buffer.from("tgz"),
    });
    expect(scanRecord.publicReportUrl).toBeNull();
  });

  it("encodes scoped names into a single safe key segment (Req 1.6, 7.3)", async () => {
    const storage = new InMemoryStorageService();
    const { scanRecord } = await storage.uploadScan({
      report: makeFakeNormalizedReport({ packageName: "@acme/widget", version: "2.1.4" }),
      reportBytes: Buffer.from("{}"),
      sourceSnapshot: Buffer.from("tgz"),
    });
    expect(scanRecord.reportKey).toBe("reports/%40acme%2Fwidget/2.1.4/report.json");
    expect(scanRecord.sourceKey).toBe("sources/%40acme%2Fwidget/2.1.4/source.tgz");
  });

  it("rejects an upload with a missing/empty identifier (Req 7.6)", async () => {
    const storage = new InMemoryStorageService();
    await expect(
      storage.uploadScan({
        report: makeFakeNormalizedReport({ packageName: "   ", version: "1.0.0" }),
        reportBytes: Buffer.from("{}"),
        sourceSnapshot: Buffer.from("tgz"),
      }),
    ).rejects.toMatchObject({ errorType: UploadErrorType.INVALID_IDENTIFIER });
    expect(storage.size).toBe(0);
  });

  it("stores a distinct record per scanned version (Req 9.3)", async () => {
    const storage = new InMemoryStorageService();
    await storage.uploadScan({
      report: makeFakeNormalizedReport({ packageName: "left-pad", version: "1.3.0" }),
      reportBytes: Buffer.from("{}"),
      sourceSnapshot: Buffer.from("tgz"),
    });
    await storage.uploadScan({
      report: makeFakeNormalizedReport({ packageName: "left-pad", version: "1.2.0" }),
      reportBytes: Buffer.from("{}"),
      sourceSnapshot: Buffer.from("tgz"),
    });
    const gallery = await storage.listScans();
    expect(gallery.records).toHaveLength(2);
    expect(new Set(gallery.records.map((r) => r.version))).toEqual(
      new Set(["1.3.0", "1.2.0"]),
    );
  });

  it("caps listScans at the requested limit and the gallery max (Req 9.1)", async () => {
    const storage = new InMemoryStorageService();
    for (let i = 0; i < 5; i++) {
      await storage.uploadScan({
        report: makeFakeNormalizedReport({ packageName: "pkg", version: `1.0.${i}` }),
        reportBytes: Buffer.from("{}"),
        sourceSnapshot: Buffer.from("tgz"),
      });
    }
    expect((await storage.listScans({ limit: 2 })).records).toHaveLength(2);
    expect((await storage.listScans()).records).toHaveLength(5);
    expect(GALLERY_MAX_RECORDS).toBe(100);
  });

  it("StorageError carries the typed errorType", () => {
    const err = new StorageError(UploadErrorType.UPLOAD_FAILED, "boom");
    expect(err).toBeInstanceOf(Error);
    expect(err.errorType).toBe(UploadErrorType.UPLOAD_FAILED);
  });
});

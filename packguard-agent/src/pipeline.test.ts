/**
 * Smoke / unit tests for the no-exec fetch+extract pipeline (tasks 5.1 + 6.3).
 *
 * These prove the pipeline composes download → safe-extract → Scan_Result_Contract
 * on the happy path (with an injected fake fetch serving a small valid `.tgz`,
 * so no real network is touched) and that failures surface typed errors without
 * persisting a scan-target. The exhaustive property tests — Property 1
 * (no-exec, task 5.2) and Property 8 (contract completeness, task 6.4) — are
 * SEPARATE optional tasks and are intentionally NOT implemented here.
 */

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createGzip } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pack, type Headers } from "tar-stream";

import { FetchErrorType } from "@shared/errors";
import type { ResolvedPackage } from "@shared/scan";

import { fetchAndExtract } from "./pipeline.js";
import { computeReportPath, isReportPathContained } from "./scan-result.js";

interface TarEntryInput {
  header: Headers;
  body?: string | Buffer;
}

/** Build raw gzip-compressed tar (`.tgz`) bytes from in-memory entries. */
function buildTgzBytes(entries: TarEntryInput[]): Promise<Buffer> {
  const packer = pack();
  for (const { header, body } of entries) {
    if (body !== undefined) {
      packer.entry(header, body);
    } else {
      packer.entry({ ...header, size: 0 });
    }
  }
  packer.finalize();

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const gz = packer.pipe(createGzip());
    gz.on("data", (c: Buffer) => chunks.push(c));
    gz.on("end", () => resolve(Buffer.concat(chunks)));
    gz.on("error", reject);
  });
}

/** A fake `fetch` that serves the given bytes as a successful tarball response. */
function fakeFetchServing(bytes: Buffer): typeof fetch {
  // Wrap in a fresh Uint8Array view: the DOM `BodyInit` type accepts a typed
  // array but not a Node `Buffer` directly.
  const view = new Uint8Array(bytes);
  return (async () =>
    new Response(view, {
      status: 200,
      headers: { "content-type": "application/gzip" },
    })) as unknown as typeof fetch;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

const RESOLVED: ResolvedPackage = {
  packageName: "left-pad",
  version: "1.3.0",
  tarballUrl: "https://registry.example/left-pad/-/left-pad-1.3.0.tgz",
};

describe("fetchAndExtract pipeline", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "packguard-pipeline-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("downloads, extracts, and emits a valid Scan_Result_Contract (happy path)", async () => {
    const scanTargetDir = path.join(dir, "scan-target");
    const bytes = await buildTgzBytes([
      { header: { name: "package/index.js", type: "file" }, body: "module.exports = 1;\n" },
      { header: { name: "package/package.json", type: "file" }, body: '{"name":"left-pad"}\n' },
    ]);

    const result = await fetchAndExtract(RESOLVED, {
      scanTargetDir,
      fetchFn: fakeFetchServing(bytes),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Contract completeness (Req 6.1): all four fields non-empty.
    const { contract } = result;
    expect(contract.packageName).toBe("left-pad");
    expect(contract.version).toBe("1.3.0");
    expect(contract.sourcePath.length).toBeGreaterThan(0);
    expect(contract.reportPath.length).toBeGreaterThan(0);

    // sourcePath is the canonical extraction root.
    expect(contract.sourcePath).toBe(result.canonicalRoot);

    // reportPath is inside the scan-target (Property 8 / Req 6.2).
    expect(isReportPathContained(contract.reportPath, contract.sourcePath)).toBe(true);
    expect(contract.reportPath).toBe(computeReportPath(contract.sourcePath));

    // Extracted content is present and retained for the launcher; the report
    // DIRECTORY exists but the report FILE itself is NOT created.
    expect(await exists(path.join(contract.sourcePath, "package", "index.js"))).toBe(true);
    expect(await exists(path.dirname(contract.reportPath))).toBe(true);
    expect(await exists(contract.reportPath)).toBe(false);
    expect(await readFile(path.join(contract.sourcePath, "package", "index.js"), "utf8")).toContain(
      "module.exports",
    );

    // cleanup seam removes the retained directory (Req 4.7).
    await result.cleanup();
    expect(await exists(contract.sourcePath)).toBe(false);
  });

  it("surfaces DOWNLOAD_FAILED on a non-2xx response and extracts nothing", async () => {
    const scanTargetDir = path.join(dir, "scan-target");
    const failFetch = (async () =>
      new Response("nope", { status: 503, statusText: "Service Unavailable" })) as unknown as typeof fetch;

    const result = await fetchAndExtract(RESOLVED, { scanTargetDir, fetchFn: failFetch });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorType).toBe(FetchErrorType.DOWNLOAD_FAILED);
    }
    // No extraction occurred.
    expect(await exists(scanTargetDir)).toBe(false);
  });

  it("surfaces the Extractor's distinct violation type and leaves zero residue", async () => {
    const scanTargetDir = path.join(dir, "scan-target");
    const bytes = await buildTgzBytes([
      { header: { name: "package/ok.js", type: "file" }, body: "ok\n" },
      { header: { name: "/etc/evil", type: "file" }, body: "pwned\n" },
    ]);

    const result = await fetchAndExtract(RESOLVED, {
      scanTargetDir,
      fetchFn: fakeFetchServing(bytes),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorType).toBe(FetchErrorType.ABSOLUTE_PATH);
    }
    // Extractor removed the whole scan-target on abort (Reqs 4.2–4.7).
    expect(await exists(scanTargetDir)).toBe(false);
  });
});

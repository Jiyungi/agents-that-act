/**
 * Smoke / unit tests for the streaming safe-tar `Extractor` (task 4.1).
 *
 * These prove the extractor compiles and runs on benign and a few adversarial
 * tarballs. The exhaustive property-based tests for containment, distinct
 * violation types + rollback, resource limits, and isolation are SEPARATE
 * optional tasks (4.2–4.5) and are intentionally NOT implemented here.
 */

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pack, type Headers } from "tar-stream";

import { FetchErrorType } from "@shared/errors";
import { DEFAULT_SAFE_TAR_LIMITS } from "@shared/scan";
import { safeExtract } from "./extractor.js";

interface TarEntryInput {
  header: Headers;
  body?: string | Buffer;
}

/** Build a gzip-compressed tar (`.tgz`) stream from in-memory entries. */
function buildTgz(entries: TarEntryInput[]): Readable {
  const packer = pack();
  for (const { header, body } of entries) {
    if (header.type === "symlink" || header.type === "link") {
      packer.entry(header);
    } else if (body !== undefined) {
      packer.entry(header, body);
    } else {
      packer.entry({ ...header, size: 0 });
    }
  }
  packer.finalize();
  return packer.pipe(createGzip());
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("safeExtract", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "packguard-extract-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("extracts a benign tarball and retains the populated directory", async () => {
    const target = path.join(dir, "scan-target");
    const tgz = buildTgz([
      { header: { name: "package/index.js", type: "file" }, body: "module.exports = 1;\n" },
      { header: { name: "package/lib/", type: "directory" } },
      { header: { name: "package/lib/util.js", type: "file" }, body: "export const x = 2;\n" },
    ]);

    const result = await safeExtract(tgz, target);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entryCount).toBe(3);
      expect(result.totalUncompressed).toBeGreaterThan(0);
    }
    // Directory retained for the launcher; content is inert data on disk.
    expect(await exists(path.join(target, "package", "index.js"))).toBe(true);
    expect(await readFile(path.join(target, "package", "lib", "util.js"), "utf8")).toContain(
      "export const x",
    );
  });

  it("removes the directory on success when removeTargetOnSuccess is set", async () => {
    const target = path.join(dir, "scan-target");
    const tgz = buildTgz([
      { header: { name: "package/index.js", type: "file" }, body: "ok\n" },
    ]);

    const result = await safeExtract(tgz, target, { removeTargetOnSuccess: true });

    expect(result.ok).toBe(true);
    expect(await exists(target)).toBe(false);
  });

  it("rejects an absolute-path entry with ABSOLUTE_PATH and leaves zero residue", async () => {
    const target = path.join(dir, "scan-target");
    const tgz = buildTgz([
      { header: { name: "package/ok.js", type: "file" }, body: "ok\n" },
      { header: { name: "/etc/evil", type: "file" }, body: "pwned\n" },
    ]);

    const result = await safeExtract(tgz, target);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorType).toBe(FetchErrorType.ABSOLUTE_PATH);
    }
    expect(await exists(target)).toBe(false);
  });

  it("rejects a ../ traversal entry with PATH_TRAVERSAL", async () => {
    const target = path.join(dir, "scan-target");
    const tgz = buildTgz([
      { header: { name: "package/../../escape.js", type: "file" }, body: "x\n" },
    ]);

    const result = await safeExtract(tgz, target);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorType).toBe(FetchErrorType.PATH_TRAVERSAL);
    }
    expect(await exists(target)).toBe(false);
  });

  it("rejects a symlink whose target escapes with LINK_TARGET_ESCAPE and writes no live link", async () => {
    const target = path.join(dir, "scan-target");
    const tgz = buildTgz([
      {
        header: { name: "package/evil-link", type: "symlink", linkname: "../../../../etc/passwd" },
      },
    ]);

    const result = await safeExtract(tgz, target);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorType).toBe(FetchErrorType.LINK_TARGET_ESCAPE);
    }
    expect(await exists(target)).toBe(false);
  });

  it("stores an in-bounds symlink as an inert placeholder file (never a live link)", async () => {
    const target = path.join(dir, "scan-target");
    const tgz = buildTgz([
      { header: { name: "package/real.js", type: "file" }, body: "real\n" },
      { header: { name: "package/alias.js", type: "symlink", linkname: "real.js" } },
    ]);

    const result = await safeExtract(tgz, target);

    expect(result.ok).toBe(true);
    const aliasPath = path.join(target, "package", "alias.js");
    const lstatLink = await import("node:fs/promises").then((m) => m.lstat(aliasPath));
    // Inert placeholder is a regular file, NOT a symlink.
    expect(lstatLink.isSymbolicLink()).toBe(false);
    expect(lstatLink.isFile()).toBe(true);
    const contents = await readFile(aliasPath, "utf8");
    expect(contents).toContain("packguardInertLink");
  });

  it("aborts with RESOURCE_LIMIT_EXCEEDED when the entry count cap is exceeded", async () => {
    const target = path.join(dir, "scan-target");
    const entries: TarEntryInput[] = [];
    for (let i = 0; i < 5; i++) {
      entries.push({ header: { name: `package/f${i}.js`, type: "file" }, body: "x\n" });
    }
    const tgz = buildTgz(entries);

    const result = await safeExtract(tgz, target, {
      limits: { ...DEFAULT_SAFE_TAR_LIMITS, maxEntryCount: 3 },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorType).toBe(FetchErrorType.RESOURCE_LIMIT_EXCEEDED);
    }
    expect(await exists(target)).toBe(false);
  });

  it("aborts with RESOURCE_LIMIT_EXCEEDED when uncompressed bytes exceed the cap", async () => {
    const target = path.join(dir, "scan-target");
    const big = "a".repeat(1024);
    const tgz = buildTgz([
      { header: { name: "package/big.txt", type: "file" }, body: big },
    ]);

    const result = await safeExtract(tgz, target, {
      limits: { ...DEFAULT_SAFE_TAR_LIMITS, maxUncompressedBytes: 100 },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorType).toBe(FetchErrorType.RESOURCE_LIMIT_EXCEEDED);
    }
    expect(await exists(target)).toBe(false);
  });
});

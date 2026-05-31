/**
 * Streaming safe-tar `Extractor` (Person A, task 4.1).
 *
 * Implements the "Safe-Tar Extraction Algorithm" from design.md verbatim. The
 * `Extractor` is the highest-risk component in PackGuard: it processes fully
 * untrusted `.tgz` archives downloaded from the npm registry. Per the core
 * "inspect without installing" constraint (Req 3), extracted content is INERT
 * read-only data for static scanning — nothing here ever executes, requires,
 * imports, or evaluates package content, and we NEVER create live links.
 *
 * Design choices (see design.md → "Safe-Tar Extraction Algorithm"):
 *  - Stream the gzip through `node:zlib`'s `createGunzip` into a streaming
 *    `tar-stream` reader, validating every entry ourselves. We never use a
 *    library auto-extract that may follow links or write before validating.
 *    Cumulative uncompressed bytes are counted DURING the stream so a
 *    decompression bomb is aborted mid-stream (Req 3.8).
 *  - Resolve the canonical root ONCE up front via `realpath`, then perform a
 *    lexical containment check on every entry (Property 2, Reqs 4.1, 3.1).
 *  - Three distinct violation types — `ABSOLUTE_PATH`, `PATH_TRAVERSAL`,
 *    `LINK_TARGET_ESCAPE` — produced from three separate branches
 *    (Property 3, Reqs 4.2–4.5).
 *  - Intermediate-symlink defense: every parent component is re-checked, and
 *    directory creation / file opening use no-follow semantics (`O_NOFOLLOW`)
 *    so the final path component can never be a followed symlink (Req 4.5).
 *  - Symlink/hardlink entries are written as INERT PLACEHOLDER files (the link
 *    metadata stored as data), never as real links — this removes the entire
 *    class of link-following write escapes while preserving the file listing
 *    for the scanner.
 *  - On any abort: roll back all written paths so zero entries from that
 *    tarball remain (Reqs 4.2–4.5), then remove the whole directory.
 *
 * ── The finally-cleanup vs. sourcePath seam ──────────────────────────────
 * The design's algorithm has a `finally` that `removeRecursively(scanTargetDir)`
 * on BOTH success and abort (Req 4.7). That conflicts with Req 5.1, which needs
 * the populated `./scan-target/` to survive so the `Editor_Launcher` can open
 * it and the operator can run the manual Opsera scan + upload against it.
 *
 * Per the task's guidance, cleanup is therefore an explicit, well-documented
 * method ({@link cleanupScanTarget}) rather than an unconditional `finally`:
 *  - On ABORT (any violation / timeout / extraction failure): the directory is
 *    removed immediately here — nothing from a rejected package ever persists
 *    (Reqs 4.2–4.7).
 *  - On SUCCESS: the directory is RETAINED by default so the orchestration
 *    layer (task 5.1 pipeline) can hand a populated `sourcePath` to the
 *    launcher. The orchestration layer is responsible for calling
 *    {@link cleanupScanTarget} in its own `finally` once the whole scan
 *    lifecycle (launch → manual scan → upload) completes, which is the point
 *    at which Req 4.7's "extraction for a package completes" truly holds.
 *  - Callers that want the strict algorithm (cleanup on success too) can pass
 *    `removeTargetOnSuccess: true`.
 *
 * This is a deliberate, documented deviation from a literal reading of the
 * pseudocode's `finally`, made to satisfy Reqs 5.1/5.4 without weakening the
 * zero-residue guarantee on the abort path.
 */

import { constants as fsConstants } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

import { extract as createTarExtract } from "tar-stream";
import type { Entry, Headers } from "tar-stream";

import { FetchErrorType } from "@shared/errors";
import { DEFAULT_SAFE_TAR_LIMITS, type SafeTarLimits } from "@shared/scan";

/**
 * The subset of {@link FetchErrorType} the `Extractor` can produce. Keeping the
 * three path/link violation types distinct is a hard requirement (Reqs 4.2–4.5).
 */
export type ExtractorErrorType =
  | typeof FetchErrorType.PATH_TRAVERSAL
  | typeof FetchErrorType.ABSOLUTE_PATH
  | typeof FetchErrorType.LINK_TARGET_ESCAPE
  | typeof FetchErrorType.RESOURCE_LIMIT_EXCEEDED
  | typeof FetchErrorType.EXTRACTION_TIMEOUT;

/** Successful extraction outcome. */
export interface ExtractSuccess {
  ok: true;
  /** Canonical (realpath-resolved) extraction root. */
  canonicalRoot: string;
  /** Number of tar entries processed. */
  entryCount: number;
  /** Cumulative uncompressed bytes written. */
  totalUncompressed: number;
}

/** Aborted extraction outcome, mapped to a distinct {@link ExtractorErrorType}. */
export interface ExtractFailure {
  ok: false;
  errorType: ExtractorErrorType;
  message: string;
}

/**
 * Typed result object. The `Extractor` NEVER throws across its boundary; it
 * returns this discriminated union so the orchestration layer can branch and
 * map onto the Backend_API error contract.
 */
export type ExtractResult = ExtractSuccess | ExtractFailure;

/** Options for {@link safeExtract}. */
export interface SafeExtractOptions {
  /** Resource limits (Reqs 2.4, 3.8). Defaults to {@link DEFAULT_SAFE_TAR_LIMITS}. */
  limits?: SafeTarLimits;
  /** Overall extraction timeout in ms (Req 3.7). Defaults to 30_000. */
  timeoutMs?: number;
  /**
   * Whether to remove the whole Scan_Target_Directory after a SUCCESSFUL
   * extraction. Defaults to `false` — see the "finally-cleanup vs. sourcePath
   * seam" note at the top of this file. On ABORT the directory is always
   * removed regardless of this flag.
   */
  removeTargetOnSuccess?: boolean;
}

/** Default extraction timeout (Req 3.7: 30 seconds). */
export const DEFAULT_EXTRACTION_TIMEOUT_MS = 30_000;

/** `O_NOFOLLOW` is absent / 0 on some platforms (e.g. Windows); fall back to 0. */
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/**
 * No-follow, fail-if-exists write flags for the FINAL path component
 * (`fs.open` 'wx' + O_NOFOLLOW): create + write-only + exclusive + never
 * follow a terminal symlink. This guarantees we never write THROUGH a symlink
 * and never overwrite an existing entry (Req 4.5).
 */
const WRITE_NOFOLLOW_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  O_NOFOLLOW;

/**
 * Internal control-flow error used to abort the stream with a distinct
 * violation type. Never escapes the module — it is converted into an
 * {@link ExtractFailure}.
 */
class AbortViolation extends Error {
  readonly violationType: ExtractorErrorType;
  constructor(violationType: ExtractorErrorType, message: string) {
    super(message);
    this.name = "AbortViolation";
    this.violationType = violationType;
  }
}

/** `true` iff `candidate` is equal to or a descendant of `root`. */
function isWithinRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/**
 * Detect absolute paths in their many forms: POSIX leading `/`, leading
 * backslash, Windows drive roots (`C:\`, `C:/`), drive-relative (`C:foo`), and
 * UNC paths (`\\server\share`). Any of these is a distinct ABSOLUTE_PATH
 * violation (Req 4.3) — kept separate from `../` traversal.
 */
function isAbsoluteEntryName(name: string): boolean {
  if (name.startsWith("/") || name.startsWith("\\")) return true;
  if (path.isAbsolute(name)) return true;
  // win32 view catches drive roots and UNC even on POSIX hosts.
  if (path.win32.isAbsolute(name)) return true;
  // Drive-relative form like "C:foo" (win32.isAbsolute returns false for this).
  if (/^[a-zA-Z]:/.test(name)) return true;
  return false;
}

/**
 * Resolve a link entry's target to an absolute path for the containment check.
 *  - Absolute targets are taken as-is (they almost always escape → caught).
 *  - Hardlink (`type === "link"`) targets are relative to the archive root.
 *  - Symlink targets are relative to the link's own directory.
 *
 * We only resolve lexically; we never create a real link, so a target that
 * stays inside the root but points at a nonexistent path is harmless.
 */
function resolveLinkTarget(
  canonicalRoot: string,
  dest: string,
  linkname: string,
  type: "symlink" | "link",
): string {
  if (path.isAbsolute(linkname) || path.win32.isAbsolute(linkname)) {
    return path.normalize(linkname);
  }
  if (type === "link") {
    return path.normalize(path.join(canonicalRoot, linkname));
  }
  return path.normalize(path.join(path.dirname(dest), linkname));
}

/**
 * Ensure the empty `Scan_Target_Directory` precondition (Req 4.6, Property 5):
 * the directory must exist and contain zero carried-over entries before
 * extraction.
 *
 * Normal case: remove the whole tree and recreate it fresh. Windows fallback:
 * if the root cannot be removed because an editor (VS Code / Kiro) still holds
 * the folder open (EBUSY/EPERM), empty its CONTENTS instead so the precondition
 * still holds without failing the scan.
 */
async function ensureEmptyDir(dir: string): Promise<void> {
  await removeTreeOrEmptyContents(dir);
  await fsp.mkdir(dir, { recursive: true });
}

/**
 * Remove `dir` entirely. If removing the root fails due to a transient/handle
 * lock (EBUSY/EPERM — typical when an editor has the folder open on Windows),
 * fall back to removing only its children so zero entries remain. Best-effort:
 * never throws.
 */
async function removeTreeOrEmptyContents(dir: string): Promise<void> {
  for (let i = 0; i < 4; i++) {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY") {
        if (i < 3) {
          await new Promise((r) => setTimeout(r, 120));
          continue;
        }
        // Root is held open: empty the contents instead.
        await emptyDirContents(dir);
        return;
      }
      return; // other errors (e.g. ENOENT) → nothing to remove
    }
  }
}

/** Remove every child of `dir` (best-effort), leaving the root in place. */
async function emptyDirContents(dir: string): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    for (let i = 0; i < 4; i++) {
      try {
        await fsp.rm(path.join(dir, name), { recursive: true, force: true });
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if ((code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY") && i < 3) {
          await new Promise((r) => setTimeout(r, 120));
          continue;
        }
        break; // best-effort
      }
    }
  }
}

/**
 * Create every directory component from `canonicalRoot` down to `dirPath`
 * WITHOUT following symlinks, re-checking each existing parent (Reqs 4.5).
 * Throws {@link AbortViolation}(LINK_TARGET_ESCAPE) if an existing parent is a
 * symlink resolving outside the root.
 */
async function ensureDirNoFollow(
  dirPath: string,
  canonicalRoot: string,
): Promise<void> {
  const rel = path.relative(canonicalRoot, dirPath);
  // dirPath === canonicalRoot → nothing to create.
  if (rel === "") return;
  // Defensive: dirPath should already be validated as within root.
  if (rel === ".." || rel.startsWith(".." + path.sep)) {
    throw new AbortViolation(
      FetchErrorType.PATH_TRAVERSAL,
      `directory escapes scan target: ${dirPath}`,
    );
  }

  let current = canonicalRoot;
  for (const component of rel.split(path.sep)) {
    current = path.join(current, component);
    let stat: Awaited<ReturnType<typeof fsp.lstat>> | null = null;
    try {
      stat = await fsp.lstat(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    if (stat === null) {
      // Parent is guaranteed to be a real directory (we just validated/created
      // it), so a non-recursive mkdir cannot traverse a symlink.
      await fsp.mkdir(current);
      continue;
    }
    if (stat.isSymbolicLink()) {
      const real = await fsp.realpath(current);
      if (!isWithinRoot(real, canonicalRoot)) {
        throw new AbortViolation(
          FetchErrorType.LINK_TARGET_ESCAPE,
          `intermediate symlink escapes scan target: ${current}`,
        );
      }
      // A symlink resolving inside the root is permitted by the algorithm, but
      // since we never create real links this branch is effectively
      // unreachable from a freshly cleared root.
      continue;
    }
    if (!stat.isDirectory()) {
      // A non-directory is in the way (e.g. duplicate/conflicting entry).
      throw new AbortViolation(
        FetchErrorType.EXTRACTION_TIMEOUT,
        `path component is not a directory: ${current}`,
      );
    }
  }
}

/** Fully consume (and discard) an entry's body so the tar stream can advance. */
async function drainEntry(entry: Entry): Promise<void> {
  for await (const _chunk of entry) {
    // discard — content is irrelevant for non-file/non-placeholder entries.
  }
}

/**
 * Write a symlink/hardlink entry as an INERT PLACEHOLDER regular file. We store
 * the link metadata as data and NEVER create a live link, removing the entire
 * class of link-following write escapes (design.md). The body, if any, is
 * drained and discarded.
 */
async function writeInertPlaceholder(
  dest: string,
  header: Headers,
  entry: Entry,
): Promise<void> {
  await drainEntry(entry);
  const placeholder =
    JSON.stringify(
      {
        packguardInertLink: true,
        type: header.type,
        name: header.name,
        linkname: header.linkname ?? null,
      },
      null,
      2,
    ) + "\n";
  const handle = await fsp.open(dest, WRITE_NOFOLLOW_FLAGS);
  try {
    await handle.writeFile(placeholder);
  } finally {
    await handle.close();
  }
}

/**
 * Stream a regular file entry to `dest` using no-follow / exclusive open,
 * enforcing the cumulative uncompressed byte cap DURING the stream
 * (Req 3.8, Property 4). Returns the running total after writing this entry.
 */
async function writeRegularFile(
  dest: string,
  entry: Entry,
  limits: SafeTarLimits,
  runningTotal: number,
): Promise<number> {
  let total = runningTotal;
  const handle = await fsp.open(dest, WRITE_NOFOLLOW_FLAGS);
  try {
    for await (const chunk of entry) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > limits.maxUncompressedBytes) {
        throw new AbortViolation(
          FetchErrorType.RESOURCE_LIMIT_EXCEEDED,
          `uncompressed size exceeds ${limits.maxUncompressedBytes} bytes`,
        );
      }
      await handle.write(buf);
    }
  } finally {
    await handle.close();
  }
  return total;
}

/** Best-effort removal of every written path so zero entries remain on abort. */
async function rollbackWrittenPaths(writtenPaths: string[]): Promise<void> {
  // Reverse order so deeper paths are removed before their parents.
  for (const p of [...writtenPaths].reverse()) {
    try {
      await fsp.rm(p, { force: true });
    } catch {
      // best-effort; the whole-tree removal below is the real guarantee.
    }
  }
}

/**
 * Remove the entire `Scan_Target_Directory` and all its contents (Req 4.7).
 *
 * Normal case removes the whole tree. If an editor (VS Code / Kiro) still holds
 * the folder open on Windows (EBUSY/EPERM), it falls back to emptying the
 * contents so no extracted package content persists, without hard-failing.
 */
export async function cleanupScanTarget(scanTargetDir: string): Promise<void> {
  await removeTreeOrEmptyContents(scanTargetDir);
}

/**
 * Run the streaming extraction loop. Throws {@link AbortViolation} on any
 * violation/timeout/extraction failure; returns counters on success. Mutates
 * `writtenPaths` so the caller can roll back.
 */
async function runStream(
  tgzStream: Readable,
  canonicalRoot: string,
  limits: SafeTarLimits,
  timeoutMs: number,
  writtenPaths: string[],
): Promise<{ entryCount: number; totalUncompressed: number }> {
  const gunzip = createGunzip();
  const tarReader = createTarExtract();

  let entryCount = 0;
  let totalUncompressed = 0;
  let timedOut = false;

  // Propagate upstream errors into the tar reader so the for-await rejects.
  tgzStream.on("error", (err) => tarReader.destroy(err));
  gunzip.on("error", (err) => tarReader.destroy(err));
  tgzStream.pipe(gunzip).pipe(tarReader);

  const timer = setTimeout(() => {
    timedOut = true;
    tarReader.destroy(new Error("extraction timeout"));
  }, timeoutMs);

  try {
    for await (const entry of tarReader) {
      const header = entry.header;

      entryCount += 1;
      if (entryCount > limits.maxEntryCount) {
        throw new AbortViolation(
          FetchErrorType.RESOURCE_LIMIT_EXCEEDED,
          `entry count exceeds ${limits.maxEntryCount}`,
        );
      }

      const name = header.name;

      // 1) Absolute path → distinct ABSOLUTE_PATH violation (Req 4.3).
      if (isAbsoluteEntryName(name)) {
        throw new AbortViolation(
          FetchErrorType.ABSOLUTE_PATH,
          `absolute path entry rejected: ${name}`,
        );
      }

      // 2) Compute intended destination WITHOUT touching the filesystem yet.
      const dest = path.normalize(path.join(canonicalRoot, name));

      // 3) Lexical containment check → PATH_TRAVERSAL (Reqs 3.6, 4.2).
      if (!isWithinRoot(dest, canonicalRoot)) {
        throw new AbortViolation(
          FetchErrorType.PATH_TRAVERSAL,
          `entry escapes scan target: ${name}`,
        );
      }

      const type = header.type ?? "file";

      // 4) Create parent dirs no-follow; re-check intermediate symlinks (Req 4.5).
      //    A directory entry creates `dest` itself; others create `dirname(dest)`.
      if (type === "directory") {
        await ensureDirNoFollow(dest, canonicalRoot);
        await drainEntry(entry);
        continue;
      }
      await ensureDirNoFollow(path.dirname(dest), canonicalRoot);

      // 5) Link entries: validate resolved target (Req 4.4), then write inert.
      if (type === "symlink" || type === "link") {
        const target = resolveLinkTarget(
          canonicalRoot,
          dest,
          header.linkname ?? "",
          type,
        );
        if (!isWithinRoot(target, canonicalRoot)) {
          throw new AbortViolation(
            FetchErrorType.LINK_TARGET_ESCAPE,
            `link target escapes scan target: ${name} -> ${header.linkname ?? ""}`,
          );
        }
        await writeInertPlaceholder(dest, header, entry);
        writtenPaths.push(dest);
        continue;
      }

      // 6) Regular file: stream with a running size cap (Req 3.8).
      if (type === "file" || type === "contiguous-file") {
        totalUncompressed = await writeRegularFile(
          dest,
          entry,
          limits,
          totalUncompressed,
        );
        writtenPaths.push(dest);
        continue;
      }

      // Other types (devices, fifos, pax/gnu metadata): never materialize a
      // special node — drain and skip. The name was still validated above.
      await drainEntry(entry);
    }

    return { entryCount, totalUncompressed };
  } catch (err) {
    if (timedOut) {
      throw new AbortViolation(
        FetchErrorType.EXTRACTION_TIMEOUT,
        `extraction did not complete within ${timeoutMs}ms`,
      );
    }
    if (err instanceof AbortViolation) throw err;
    // Generic gunzip/tar failure: per the error table, an extraction failure
    // maps to EXTRACTION_TIMEOUT (Req 3.7).
    const message = err instanceof Error ? err.message : String(err);
    throw new AbortViolation(
      FetchErrorType.EXTRACTION_TIMEOUT,
      `extraction failed: ${message}`,
    );
  } finally {
    clearTimeout(timer);
    if (!tarReader.destroyed) tarReader.destroy();
    if (!gunzip.destroyed) gunzip.destroy();
    if (typeof tgzStream.destroy === "function" && !tgzStream.destroyed) {
      tgzStream.destroy();
    }
  }
}

/**
 * Safely extract a gzip-compressed tarball stream into `scanTargetDir`,
 * enforcing every "inspect without installing" and path-traversal protection
 * from Reqs 3 & 4. Returns a typed {@link ExtractResult}; never throws across
 * its boundary.
 *
 * Behavior summary:
 *  - Preconditions: the target is (re)created empty before extraction (Req 4.6).
 *  - On success: returns `{ ok: true, canonicalRoot, entryCount, totalUncompressed }`
 *    and, by default, RETAINS the populated directory for the launcher
 *    (see the seam note at the top of this file).
 *  - On abort: rolls back all written paths AND removes the whole directory so
 *    zero entries persist (Reqs 4.2–4.7), and returns
 *    `{ ok: false, errorType, message }` with the distinct violation type.
 */
export async function safeExtract(
  tgzStream: Readable,
  scanTargetDir: string,
  options: SafeExtractOptions = {},
): Promise<ExtractResult> {
  const limits = options.limits ?? DEFAULT_SAFE_TAR_LIMITS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXTRACTION_TIMEOUT_MS;
  const removeTargetOnSuccess = options.removeTargetOnSuccess ?? false;

  const writtenPaths: string[] = [];

  // Preconditions (Req 4.6): exist + empty. Resolve canonical root ONCE.
  await ensureEmptyDir(scanTargetDir);
  const canonicalRoot = await fsp.realpath(scanTargetDir);

  try {
    const { entryCount, totalUncompressed } = await runStream(
      tgzStream,
      canonicalRoot,
      limits,
      timeoutMs,
      writtenPaths,
    );

    if (removeTargetOnSuccess) {
      await cleanupScanTarget(scanTargetDir);
    }
    return { ok: true, canonicalRoot, entryCount, totalUncompressed };
  } catch (err) {
    // Abort: zero residue. Roll back written paths, then remove the whole tree
    // (Reqs 4.2–4.7). The directory is ALWAYS removed on the abort path,
    // independent of `removeTargetOnSuccess`.
    await rollbackWrittenPaths(writtenPaths);
    await cleanupScanTarget(scanTargetDir);

    if (err instanceof AbortViolation) {
      return { ok: false, errorType: err.violationType, message: err.message };
    }
    // Defensive: any unexpected error is treated as an extraction failure.
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errorType: FetchErrorType.EXTRACTION_TIMEOUT,
      message: `extraction failed: ${message}`,
    };
  }
}

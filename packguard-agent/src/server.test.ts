/**
 * Focused tests for the Local_Fetcher_Agent loopback server (task 7.1).
 *
 * Strategy: start the real server on `127.0.0.1:0` (ephemeral loopback port)
 * and drive it with REAL `fetch` requests for realism, but inject FAKE
 * `fetchAndExtract` / `launchEditor` / `isCodeCliAvailable` deps so NO real
 * network and NO real VS Code are touched. This exercises the actual HTTP
 * routing, body parsing, status mapping, and the uploadId seam end-to-end.
 *
 * These are example tests covering the wiring + error branches of Interface 2
 * (Reqs 5.1, 5.2, 6.1, 6.2). The safe-tar / no-exec guarantees are covered by
 * the pipeline/extractor tests; here we only verify the server composes them.
 */

import { afterEach, describe, expect, it } from "vitest";

import { FetchErrorType } from "@shared/errors";
import type { ResolvedPackage, ScanResultContract } from "@shared/scan";

import { InMemoryStorageService } from "@shared/testing/storage-fake";

import {
  FETCH_ERROR_STATUS,
  LOOPBACK_HOST,
  TransportErrorType,
  createAgentServer,
  startAgentServer,
  type AgentServerDeps,
  type StartedAgentServer,
} from "./server.js";
import type { FetchAndExtractResult } from "./pipeline.js";
import type { LaunchEditorResult } from "./editor-launcher.js";

const SAMPLE_CONTRACT: ScanResultContract = {
  packageName: "left-pad",
  version: "1.3.0",
  sourcePath: "/tmp/scan-target",
  reportPath: "/tmp/scan-target/.packguard/report.json",
};

/** A fake successful pipeline that records its cleanup invocation. */
function fakeSuccessPipeline(
  contract: ScanResultContract = SAMPLE_CONTRACT,
): { impl: AgentServerDeps["fetchAndExtractImpl"]; cleanupCalls: () => number } {
  let cleanupCount = 0;
  const impl: AgentServerDeps["fetchAndExtractImpl"] = async (
    _resolved: ResolvedPackage,
  ): Promise<FetchAndExtractResult> => ({
    ok: true,
    contract,
    canonicalRoot: contract.sourcePath,
    entryCount: 3,
    totalUncompressed: 1024,
    cleanup: async () => {
      cleanupCount += 1;
    },
  });
  return { impl, cleanupCalls: () => cleanupCount };
}

/** A fake pipeline that fails with the given fetch error type. */
function fakeFailurePipeline(
  errorType: Extract<
    FetchAndExtractResult,
    { ok: false }
  >["errorType"],
): AgentServerDeps["fetchAndExtractImpl"] {
  return async (): Promise<FetchAndExtractResult> => ({
    ok: false,
    errorType,
    message: `injected ${errorType}`,
  });
}

const fakeLaunchOk: AgentServerDeps["launchEditorImpl"] = async () =>
  ({ ok: true, prompt: "run /security-scan" }) satisfies LaunchEditorResult;

function fakeLaunchFail(
  errorType:
    | typeof FetchErrorType.VSCODE_UNAVAILABLE
    | typeof FetchErrorType.VSCODE_LAUNCH_FAILED,
): AgentServerDeps["launchEditorImpl"] {
  return async () =>
    ({
      ok: false,
      errorType,
      message: `injected ${errorType}`,
      manualCommand: 'code "/tmp/scan-target"',
    }) satisfies LaunchEditorResult;
}

let started: StartedAgentServer | undefined;

afterEach(async () => {
  if (started) {
    await new Promise<void>((resolve) => started!.server.close(() => resolve()));
    started = undefined;
  }
});

/** Start the server on an ephemeral loopback port with the given deps. */
async function start(deps: Partial<AgentServerDeps>): Promise<string> {
  started = await startAgentServer({
    port: 0,
    deps: { scanTargetDir: "/tmp/scan-target", ...deps },
  });
  return `http://${LOOPBACK_HOST}:${started.port}`;
}

const fetchBody = {
  packageName: "left-pad",
  version: "1.3.0",
  tarballUrl: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
};

describe("POST /local/fetch", () => {
  it("returns 200 with the Scan_Result_Contract + uploadId on success (Reqs 6.1, 6.2)", async () => {
    const pipeline = fakeSuccessPipeline();
    const base = await start({
      fetchAndExtractImpl: pipeline.impl,
      launchEditorImpl: fakeLaunchOk,
    });

    const res = await fetch(`${base}/local/fetch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fetchBody),
    });
    const json = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    // The four contract fields are present at the top level (body IS a contract).
    expect(json["packageName"]).toBe("left-pad");
    expect(json["version"]).toBe("1.3.0");
    expect(json["sourcePath"]).toBe(SAMPLE_CONTRACT.sourcePath);
    expect(json["reportPath"]).toBe(SAMPLE_CONTRACT.reportPath);
    // The 7.2 seam: an uploadId is returned and registered in activeScans.
    expect(typeof json["uploadId"]).toBe("string");
    expect(json["prompt"]).toBe("run /security-scan");
    expect(started!.activeScans.size).toBe(1);
    expect(started!.activeScans.has(json["uploadId"] as string)).toBe(true);
    // Success path must NOT clean up the retained scan-target.
    expect(pipeline.cleanupCalls()).toBe(0);
  });

  it("maps an injected pipeline failure to the right status + errorType", async () => {
    const base = await start({
      fetchAndExtractImpl: fakeFailurePipeline(FetchErrorType.PATH_TRAVERSAL),
      launchEditorImpl: fakeLaunchOk,
    });

    const res = await fetch(`${base}/local/fetch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fetchBody),
    });
    const json = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(FETCH_ERROR_STATUS[FetchErrorType.PATH_TRAVERSAL]); // 422
    expect(json["errorType"]).toBe(FetchErrorType.PATH_TRAVERSAL);
    // A failed fetch registers no active scan.
    expect(started!.activeScans.size).toBe(0);
  });

  it("maps DOWNLOAD_TOO_LARGE to 413", async () => {
    const base = await start({
      fetchAndExtractImpl: fakeFailurePipeline(FetchErrorType.DOWNLOAD_TOO_LARGE),
      launchEditorImpl: fakeLaunchOk,
    });

    const res = await fetch(`${base}/local/fetch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fetchBody),
    });

    expect(res.status).toBe(413);
  });

  it("returns the launcher error WITH manualCommand and RETAINS the scan-target on VSCODE_UNAVAILABLE (Req 5.3)", async () => {
    const pipeline = fakeSuccessPipeline();
    const base = await start({
      fetchAndExtractImpl: pipeline.impl,
      launchEditorImpl: fakeLaunchFail(FetchErrorType.VSCODE_UNAVAILABLE),
    });

    const res = await fetch(`${base}/local/fetch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fetchBody),
    });
    const json = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(FETCH_ERROR_STATUS[FetchErrorType.VSCODE_UNAVAILABLE]); // 503
    expect(json["errorType"]).toBe(FetchErrorType.VSCODE_UNAVAILABLE);
    expect(json["manualCommand"]).toBe('code "/tmp/scan-target"');
    // Scan-target retained (cleanup NOT called) and still uploadable.
    expect(pipeline.cleanupCalls()).toBe(0);
    expect(typeof json["uploadId"]).toBe("string");
    expect(started!.activeScans.size).toBe(1);
  });

  it("rejects an invalid package name with INVALID_PACKAGE_NAME (400) before downloading (Req 1.7)", async () => {
    let pipelineCalled = false;
    const base = await start({
      fetchAndExtractImpl: async () => {
        pipelineCalled = true;
        return { ok: false, errorType: FetchErrorType.DOWNLOAD_FAILED, message: "x" };
      },
      launchEditorImpl: fakeLaunchOk,
    });

    const res = await fetch(`${base}/local/fetch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...fetchBody, packageName: "  " }),
    });
    const json = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(json["errorType"]).toBe(FetchErrorType.INVALID_PACKAGE_NAME);
    expect(pipelineCalled).toBe(false);
  });

  it("rejects a missing tarballUrl with 400 BAD_REQUEST", async () => {
    const base = await start({
      fetchAndExtractImpl: fakeSuccessPipeline().impl,
      launchEditorImpl: fakeLaunchOk,
    });

    const res = await fetch(`${base}/local/fetch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ packageName: "left-pad", version: "1.3.0" }),
    });
    const json = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(json["errorType"]).toBe(TransportErrorType.BAD_REQUEST);
  });

  it("rejects a non-JSON body with 400 BAD_REQUEST", async () => {
    const base = await start({
      fetchAndExtractImpl: fakeSuccessPipeline().impl,
      launchEditorImpl: fakeLaunchOk,
    });

    const res = await fetch(`${base}/local/fetch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json{",
    });
    const json = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(json["errorType"]).toBe(TransportErrorType.BAD_REQUEST);
  });
});

describe("GET /local/health", () => {
  it("reports codeCliAvailable: true", async () => {
    const base = await start({
      isCodeCliAvailableImpl: async () => true,
    });

    const res = await fetch(`${base}/local/health`);
    const json = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(json["status"]).toBe("ok");
    expect(json["codeCliAvailable"]).toBe(true);
  });

  it("reports codeCliAvailable: false", async () => {
    const base = await start({
      isCodeCliAvailableImpl: async () => false,
    });

    const res = await fetch(`${base}/local/health`);
    const json = (await res.json()) as Record<string, unknown>;

    expect(json["codeCliAvailable"]).toBe(false);
  });
});

describe("routing", () => {
  it("returns 404 for an unknown route", async () => {
    const base = await start({ isCodeCliAvailableImpl: async () => true });

    const res = await fetch(`${base}/local/nope`);
    const json = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(404);
    expect(json["errorType"]).toBe(TransportErrorType.NOT_FOUND);
  });

  it("returns 405 for the wrong method on a known route", async () => {
    const base = await start({ isCodeCliAvailableImpl: async () => true });

    // /local/health is GET-only; POST should be 405.
    const res = await fetch(`${base}/local/health`, { method: "POST" });
    const json = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(405);
    expect(json["errorType"]).toBe(TransportErrorType.METHOD_NOT_ALLOWED);
  });

  it("registers /local/upload (no longer 404); replies 503 when no Storage_Service is configured (task 7.2)", async () => {
    const base = await start({ isCodeCliAvailableImpl: async () => true });

    const res = await fetch(`${base}/local/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uploadId: "x" }),
    });

    // Route now exists (task 7.2). With no storageService injected and an
    // unknown uploadId, the unknown-id guard fires first → 404 INVALID_IDENTIFIER.
    expect(res.status).toBe(404);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["errorType"]).toBe("INVALID_IDENTIFIER");
  });
});

describe("createAgentServer (direct, no port bind)", () => {
  it("exposes activeScans and a handleRequest listener", () => {
    const agent = createAgentServer({ scanTargetDir: "/tmp/scan-target" });
    expect(agent.activeScans).toBeInstanceOf(Map);
    expect(typeof agent.handleRequest).toBe("function");
    expect(agent.server).toBeDefined();
  });
});

describe("POST /local/upload (task 7.2 wiring)", () => {
  it("uploads a present report → 200 { scanRecord }, calls cleanup, drops the active scan (Reqs 6.3, 6.4)", async () => {
    const storage = new InMemoryStorageService();
    let cleanupCalls = 0;
    const base = await start({
      storageService: storage,
      // Inject a report reader + snapshot so no real disk is needed here.
      readReport: async () => ({
        exists: true,
        bytes: Buffer.from(JSON.stringify({ riskScore: 8 })),
      }),
      makeSnapshot: async () => Buffer.from("snapshot"),
    });

    // Register an active scan directly (as /local/fetch would).
    const uploadId = "upload-123";
    started!.activeScans.set(uploadId, {
      contract: SAMPLE_CONTRACT,
      cleanup: async () => {
        cleanupCalls += 1;
      },
      createdAt: new Date().toISOString(),
    });

    const res = await fetch(`${base}/local/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uploadId }),
    });
    const json = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    const scanRecord = json["scanRecord"] as Record<string, unknown>;
    expect(scanRecord["packageName"]).toBe("left-pad");
    expect(scanRecord["verdict"]).toBe("SAFE"); // 8 < 50
    expect(storage.size).toBe(1);
    expect(cleanupCalls).toBe(1);
    // The uploadId is consumed so it can't be reused.
    expect(started!.activeScans.has(uploadId)).toBe(false);
  });

  it("returns REPORT_MISSING (404) and retains the active scan when no report exists (Req 6.5)", async () => {
    const storage = new InMemoryStorageService();
    const base = await start({
      storageService: storage,
      readReport: async () => ({ exists: false }),
    });

    const uploadId = "upload-missing";
    started!.activeScans.set(uploadId, {
      contract: SAMPLE_CONTRACT,
      cleanup: async () => undefined,
      createdAt: new Date().toISOString(),
    });

    const res = await fetch(`${base}/local/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uploadId }),
    });
    const json = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(404);
    expect(json["errorType"]).toBe("REPORT_MISSING");
    expect(storage.size).toBe(0); // storage not called
    expect(started!.activeScans.has(uploadId)).toBe(true); // retained for retry
  });

  it("returns UPLOAD_FAILED (502) and keeps the active scan when storage fails (Req 6.6)", async () => {
    const failingStorage = {
      uploadScan: async () => {
        throw new Error("tigris unreachable");
      },
      getPublicReportUrl: async () => null,
      listScans: async () => ({ records: [], partial: false, unavailable: false }),
    };
    let cleanupCalls = 0;
    const base = await start({
      storageService: failingStorage,
      readReport: async () => ({
        exists: true,
        bytes: Buffer.from(JSON.stringify({ riskScore: 8 })),
      }),
      makeSnapshot: async () => Buffer.from("snapshot"),
    });

    const uploadId = "upload-fail";
    started!.activeScans.set(uploadId, {
      contract: SAMPLE_CONTRACT,
      cleanup: async () => {
        cleanupCalls += 1;
      },
      createdAt: new Date().toISOString(),
    });

    const res = await fetch(`${base}/local/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uploadId }),
    });
    const json = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(502);
    expect(json["errorType"]).toBe("UPLOAD_FAILED");
    expect(cleanupCalls).toBe(0); // report retained
    expect(started!.activeScans.has(uploadId)).toBe(true); // kept for retry
  });

  it("returns INVALID_IDENTIFIER (404) for an unknown uploadId", async () => {
    const base = await start({ storageService: new InMemoryStorageService() });

    const res = await fetch(`${base}/local/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uploadId: "does-not-exist" }),
    });
    const json = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(404);
    expect(json["errorType"]).toBe("INVALID_IDENTIFIER");
  });

  it("returns INVALID_IDENTIFIER (400) for a missing uploadId", async () => {
    const base = await start({ storageService: new InMemoryStorageService() });

    const res = await fetch(`${base}/local/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const json = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(json["errorType"]).toBe("INVALID_IDENTIFIER");
  });
});

/**
 * Minimal smoke tests for the Editor_Launcher (task 6.1).
 *
 * These inject a fake `spawn` so we exercise every branch WITHOUT launching a
 * real VS Code. The exhaustive example tests (launch success, prompt shown,
 * `code` missing, launch failure) are the SEPARATE optional task 6.2 and are
 * intentionally kept lightweight here.
 */

import { EventEmitter } from "node:events";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { FetchErrorType } from "@shared/errors";
import {
  SECURITY_SCAN_PROMPT,
  isCodeCliAvailable,
  launchEditor,
  manualOpenCommand,
  type ChildProcessLike,
  type SpawnImpl,
} from "./editor-launcher.js";

/** A fake child process that lets a test drive `error`/`exit` events. */
class FakeChild extends EventEmitter implements ChildProcessLike {
  killed = false;
  unrefCalls = 0;
  kill(): boolean {
    this.killed = true;
    return true;
  }
  unref(): void {
    this.unrefCalls += 1;
  }
}

/**
 * Build a fake `spawn` that records its args and emits the scripted lifecycle
 * on the returned child on the next tick.
 */
function fakeSpawn(
  script: (child: FakeChild) => void,
): { spawnImpl: SpawnImpl; calls: { command: string; args: readonly string[] }[] } {
  const calls: { command: string; args: readonly string[] }[] = [];
  const spawnImpl: SpawnImpl = (command, args) => {
    calls.push({ command, args });
    const child = new FakeChild();
    setImmediate(() => script(child));
    return child;
  };
  return { spawnImpl, calls };
}

describe("launchEditor", () => {
  it("launches `code <abs scan target>` and returns the /security-scan prompt on success (Reqs 5.1, 5.2)", async () => {
    const { spawnImpl, calls } = fakeSpawn((child) => child.emit("exit", 0, null));

    const result = await launchEditor("./scan-target", { spawnImpl });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.prompt).toBe(SECURITY_SCAN_PROMPT);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("code");
    expect(calls[0]?.args).toEqual([path.resolve("./scan-target")]);
  });

  it("returns VSCODE_UNAVAILABLE with a manual command when `code` is absent (Req 5.3)", async () => {
    const enoent = Object.assign(new Error("spawn code ENOENT"), { code: "ENOENT" });
    const { spawnImpl } = fakeSpawn((child) => child.emit("error", enoent));

    const result = await launchEditor("./scan-target", { spawnImpl });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorType).toBe(FetchErrorType.VSCODE_UNAVAILABLE);
      expect(result.manualCommand).toBe(manualOpenCommand("./scan-target"));
    }
  });

  it("returns VSCODE_LAUNCH_FAILED on a non-zero exit (Req 5.4)", async () => {
    const { spawnImpl } = fakeSpawn((child) => child.emit("exit", 1, null));

    const result = await launchEditor("./scan-target", { spawnImpl });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorType).toBe(FetchErrorType.VSCODE_LAUNCH_FAILED);
      expect(result.manualCommand).toContain("scan-target");
    }
  });

  it("returns VSCODE_LAUNCH_FAILED when the launch does not complete within the timeout (Req 5.4)", async () => {
    // Fake child never emits — forces the timeout branch.
    const { spawnImpl } = fakeSpawn(() => {});

    const result = await launchEditor("./scan-target", { spawnImpl, timeoutMs: 10 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorType).toBe(FetchErrorType.VSCODE_LAUNCH_FAILED);
  });
});

describe("isCodeCliAvailable", () => {
  it("resolves true when `code --version` exits cleanly", async () => {
    const { spawnImpl, calls } = fakeSpawn((child) => child.emit("exit", 0, null));

    await expect(isCodeCliAvailable({ spawnImpl })).resolves.toBe(true);
    expect(calls[0]?.args).toEqual(["--version"]);
  });

  it("resolves false when the `code` command is missing", async () => {
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const { spawnImpl } = fakeSpawn((child) => child.emit("error", enoent));

    await expect(isCodeCliAvailable({ spawnImpl })).resolves.toBe(false);
  });
});

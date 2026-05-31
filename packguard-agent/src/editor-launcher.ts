/**
 * Editor_Launcher (Person A, task 6.1).
 *
 * After the `Extractor` succeeds, this component opens VS Code on the
 * `Scan_Target_Directory` (`code ./scan-target/`) so the Operator can run the
 * manual Opsera scan (`/security-scan` in GitHub Copilot Chat). It implements
 * Requirement 5 and the design's "Editor_Launcher (Person A)" section plus the
 * Error Handling table:
 *
 *  - On successful extraction, launch VS Code within 10s and surface the
 *    `/security-scan` prompt text (Reqs 5.1, 5.2). The actual UI display is
 *    Person B's job, so this launcher RETURNS the prompt rather than rendering
 *    it.
 *  - If the `code` CLI is NOT on the host → `VSCODE_UNAVAILABLE`; state the
 *    manual open command (Req 5.3).
 *  - If `code` IS present but the launch fails or does not complete within 10s
 *    → `VSCODE_LAUNCH_FAILED`; state the manual open command (Req 5.4).
 *
 * ── Retention guarantee ──────────────────────────────────────────────────
 * This launcher NEVER deletes or cleans up the scan-target on ANY path. Both
 * VS Code error branches require RETAINING the populated directory so the
 * operator can open it manually (Reqs 5.3, 5.4), and the success path
 * obviously keeps it for the editor. Cleanup of the scan-target is owned by the
 * orchestration pipeline (task 5.1) via the Extractor's `cleanupScanTarget`,
 * which runs after the whole launch → manual scan → upload lifecycle.
 *
 * ── Never throws across the boundary ─────────────────────────────────────
 * Like the `Extractor`, this returns a typed discriminated union rather than
 * throwing, so the Local_Fetcher_Agent (task 7.1) can branch on `errorType`
 * and map onto the Backend_API error contract.
 *
 * ── Dependency injection for testability ─────────────────────────────────
 * The `code` command name, the launch timeout, and the `spawn` implementation
 * are all injectable so example/smoke tests can exercise every branch without
 * launching a real VS Code (see `editor-launcher.test.ts`). `GET /local/health`
 * (task 7.1) uses {@link isCodeCliAvailable} to report `codeCliAvailable`.
 */

import { spawn as nodeSpawn } from "node:child_process";
import * as path from "node:path";

import { FetchErrorType } from "@shared/errors";

/** Default `code` launch timeout (Req 5.1: within 10 seconds). */
export const DEFAULT_LAUNCH_TIMEOUT_MS = 10_000;

/** Default availability-probe timeout for {@link isCodeCliAvailable}. */
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/** The VS Code launcher CLI command (overridable for tests). */
export const DEFAULT_CODE_COMMAND = "code";

/**
 * The `/security-scan` prompt text surfaced to the Operator (Req 5.2).
 *
 * Person B's `Frontend_UI` renders this; the launcher only returns it so the
 * UI and the agent share one source of truth for the copy.
 */
export const SECURITY_SCAN_PROMPT =
  "VS Code is opening the scan target. In GitHub Copilot Chat, run " +
  "`/security-scan` to start the Opsera security scan, then return here to " +
  "upload the report.";

/**
 * The manual command an Operator can run to open the scan target themselves
 * (Reqs 5.3, 5.4). Uses the absolute path so it is unambiguous regardless of
 * the caller's working directory, and quotes it so paths with spaces work.
 */
export function manualOpenCommand(
  scanTargetDir: string,
  codeCommand: string = DEFAULT_CODE_COMMAND,
): string {
  return `${codeCommand} "${path.resolve(scanTargetDir)}"`;
}

/**
 * Minimal structural view of a spawned child process used by this module. Kept
 * intentionally narrow (and with a permissive `on` return type) so that both
 * Node's real `ChildProcess` AND a plain test `EventEmitter` (with `kill`/
 * `unref` attached) satisfy it without casts.
 */
export interface ChildProcessLike {
  on(event: string, listener: (...args: any[]) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
  unref(): void;
}

/** Spawn options this module passes; narrow on purpose. */
export interface LauncherSpawnOptions {
  stdio: "ignore";
  detached?: boolean;
}

/**
 * Injectable `spawn` signature. Defaults to `node:child_process`'s `spawn`;
 * tests pass a fake that emits `error`/`exit` synchronously-ish to drive every
 * branch without touching a real editor.
 */
export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: LauncherSpawnOptions,
) => ChildProcessLike;

const defaultSpawn: SpawnImpl = (command, args, options) =>
  nodeSpawn(command, args, options);

/** Shared options for {@link launchEditor} and {@link isCodeCliAvailable}. */
export interface LauncherOptions {
  /** The `code` command name. Defaults to {@link DEFAULT_CODE_COMMAND}. */
  codeCommand?: string;
  /** Timeout in ms before treating the operation as failed. */
  timeoutMs?: number;
  /** Injectable spawn implementation. Defaults to `node:child_process` spawn. */
  spawnImpl?: SpawnImpl;
}

/** Successful launch outcome — carries the prompt for the UI to display. */
export interface LaunchEditorSuccess {
  ok: true;
  /** The `/security-scan` instruction text for the Operator (Req 5.2). */
  prompt: string;
}

/** The two VS Code failure types this launcher can produce (Reqs 5.3, 5.4). */
export type LauncherErrorType =
  | typeof FetchErrorType.VSCODE_UNAVAILABLE
  | typeof FetchErrorType.VSCODE_LAUNCH_FAILED;

/** Failed launch outcome — always states the manual open command. */
export interface LaunchEditorFailure {
  ok: false;
  errorType: LauncherErrorType;
  message: string;
  /** The manual command to open the scan target (Reqs 5.3, 5.4). */
  manualCommand: string;
}

/** Typed result — the launcher never throws across this boundary. */
export type LaunchEditorResult = LaunchEditorSuccess | LaunchEditorFailure;

/** `true` iff a spawn error indicates the command was not found on the host. */
function isCommandNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/**
 * Launch VS Code on `scanTargetDir` (`code <absolute scan target>`), returning
 * a typed result. NEVER deletes the scan-target on any path (Reqs 5.3, 5.4).
 *
 * Branch mapping (design Error Handling table):
 *  - spawn `ENOENT` (the `code` CLI is absent) → `VSCODE_UNAVAILABLE` (Req 5.3)
 *  - any other spawn error, a non-zero exit, or no completion within the
 *    timeout → `VSCODE_LAUNCH_FAILED` (Req 5.4)
 *  - exit code 0 within the timeout → success with the `/security-scan` prompt
 *    (Reqs 5.1, 5.2)
 */
export function launchEditor(
  scanTargetDir: string,
  options: LauncherOptions = {},
): Promise<LaunchEditorResult> {
  const codeCommand = options.codeCommand ?? DEFAULT_CODE_COMMAND;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
  const spawnImpl = options.spawnImpl ?? defaultSpawn;

  const absDir = path.resolve(scanTargetDir);
  const manualCommand = manualOpenCommand(scanTargetDir, codeCommand);

  const unavailable = (message: string): LaunchEditorFailure => ({
    ok: false,
    errorType: FetchErrorType.VSCODE_UNAVAILABLE,
    message,
    manualCommand,
  });
  const launchFailed = (message: string): LaunchEditorFailure => ({
    ok: false,
    errorType: FetchErrorType.VSCODE_LAUNCH_FAILED,
    message,
    manualCommand,
  });

  return new Promise<LaunchEditorResult>((resolve) => {
    let settled = false;
    // The timer is intentionally NOT unref'd: it keeps the event loop alive
    // until we settle, so a bare `await launchEditor()` resolves even if the
    // spawned child is detached/unref'd.
    let timer: NodeJS.Timeout | undefined;

    const settle = (result: LaunchEditorResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };

    let child: ChildProcessLike;
    try {
      child = spawnImpl(codeCommand, [absDir], {
        stdio: "ignore",
        detached: true,
      });
    } catch (err) {
      // Some platforms throw synchronously instead of emitting `error`.
      settle(
        isCommandNotFound(err)
          ? unavailable(`the \`${codeCommand}\` command is not available on this host`)
          : launchFailed(
              `failed to launch VS Code: ${err instanceof Error ? err.message : String(err)}`,
            ),
      );
      return;
    }

    child.on("error", (err: Error) => {
      settle(
        isCommandNotFound(err)
          ? unavailable(`the \`${codeCommand}\` command is not available on this host`)
          : launchFailed(`failed to launch VS Code: ${err.message}`),
      );
    });

    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) {
        settle({ ok: true, prompt: SECURITY_SCAN_PROMPT });
        return;
      }
      const detail = signal !== null ? `signal ${signal}` : `exit code ${code}`;
      settle(launchFailed(`VS Code launch did not complete successfully (${detail})`));
    });

    // Let VS Code keep running independently of the (long-lived) agent process.
    try {
      child.unref();
    } catch {
      // A fake/minimal child may not implement unref; harmless to ignore.
    }

    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Best-effort; the operator can still open the retained scan-target.
      }
      settle(launchFailed(`VS Code launch did not complete within ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

/**
 * Probe whether the `code` CLI is available on the host, used by
 * `GET /local/health` to report `codeCliAvailable` (task 7.1) so the UI can
 * warn the Operator early (design "Editor_Launcher" section).
 *
 * Resolves `true` only when `code --version` starts and exits cleanly; resolves
 * `false` on a spawn error (e.g. `ENOENT`), a non-zero exit, or a timeout. This
 * never throws.
 */
export function isCodeCliAvailable(
  options: LauncherOptions = {},
): Promise<boolean> {
  const codeCommand = options.codeCommand ?? DEFAULT_CODE_COMMAND;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const spawnImpl = options.spawnImpl ?? defaultSpawn;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const settle = (value: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(value);
    };

    let child: ChildProcessLike;
    try {
      child = spawnImpl(codeCommand, ["--version"], {
        stdio: "ignore",
        detached: false,
      });
    } catch {
      settle(false);
      return;
    }

    child.on("error", () => settle(false));
    child.on("exit", (code: number | null) => settle(code === 0));

    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore — probe is best-effort.
      }
      settle(false);
    }, timeoutMs);
  });
}

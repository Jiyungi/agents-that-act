/* ============================================================
 * useScanFlow.ts — operator-sandbox scan flow.
 *
 *   IDLE → STAGING → AWAITING_SCAN → POLLING → DONE | ERROR
 *
 * Division of labour (all three sponsors, real):
 *   • Vercel  stages the package INTO the operator's Daytona sandbox (/api/stage)
 *   • Daytona holds the untrusted source in isolation
 *   • Operator runs the Opsera security scan in VS Code Copilot on that folder
 *   • Vercel  polls the sandbox (/api/poll), and when Opsera's report appears it
 *     normalizes + stores it in Tigris — the verdict shows up on its own.
 *
 * The only manual step is the genuine Opsera trigger in Copilot.
 * ============================================================ */
import { useCallback, useRef, useState } from "react";
import type { ReportSchema, ScanRecord } from "@shared/contracts";
import * as Api from "./api";
import { FRAMING } from "./framing";
import type { LogLine } from "./components/ScanProgress";

export type Phase =
  | "IDLE"
  | "STAGING"
  | "AWAITING_SCAN"
  | "POLLING"
  | "DONE"
  | "ERROR";

export interface FlowError {
  phase: string;
  errorType: string;
  message: string;
  manualCommand?: string;
}

export interface ScanFlowResult {
  record: ScanRecord | null;
  report: ReportSchema | null;
}

export interface ScanFlow {
  phase: Phase;
  target: string;
  staged: Api.StageResult | null;
  result: ScanFlowResult | null;
  error: FlowError | null;
  log: LogLine[];
  busy: boolean;
  polling: boolean;
  activeIndex: number;
  start: (name: string) => void;
  beginPolling: () => void;
  reset: () => void;
  cancel: () => void;
}

const nowStamp = () => new Date().toTimeString().slice(0, 8);
const POLL_INTERVAL_MS = 4000;
const POLL_MAX_MS = 5 * 60 * 1000; // stop polling after 5 min

export function useScanFlow(
  onComplete?: () => void,
  getSandboxId?: () => string,
): ScanFlow {
  const [phase, setPhase] = useState<Phase>("IDLE");
  const [target, setTarget] = useState("");
  const [staged, setStaged] = useState<Api.StageResult | null>(null);
  const [result, setResult] = useState<ScanFlowResult | null>(null);
  const [error, setError] = useState<FlowError | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);

  const ctrlRef = useRef<AbortController | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollStart = useRef<number>(0);

  const pushLog = (text: string, cls?: string) =>
    setLog((l) => l.concat([{ t: nowStamp(), text, cls }]));

  const clearPoll = () => {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  };

  const fail = (ph: string, err: unknown) => {
    clearPoll();
    const e = err as Api.ApiError;
    setError({
      phase: ph,
      errorType: e && e.errorType ? e.errorType : "ERROR",
      message: (e && e.message) || "Something went wrong.",
      manualCommand: e && e.manualCommand,
    });
    setPhase("ERROR");
  };

  const start = useCallback(
    (name: string) => {
      clearPoll();
      const sandboxId = getSandboxId?.() ?? "";
      if (!sandboxId) {
        fail("stage", {
          errorType: "NO_SANDBOX",
          message: "Enter your Daytona sandbox ID first (the one VS Code is connected to).",
        } as Api.ApiError);
        return;
      }
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      setError(null);
      setResult(null);
      setStaged(null);
      setTarget(name);
      setLog([]);
      setPhase("STAGING");

      pushLog("$ packguard stage " + name, "ac");
      pushLog("→ POST /api/stage  { sandboxId, packageName }");
      pushLog("Vercel is fetching + unpacking the package in your Daytona sandbox…");

      Api.stageInSandbox(sandboxId, name, ctrl.signal)
        .then((s) => {
          pushLog(
            `staged ${s.packageName}@${s.version} → ${s.scanDir}/package (never installed)`,
            "ok",
          );
          pushLog("Now run the Opsera security scan in VS Code Copilot.", "ac");
          setStaged(s);
          setPhase("AWAITING_SCAN");
        })
        .catch((err) => {
          if (Api.isAbortError(err)) {
            fail("stage", { errorType: "TIMEOUT", message: FRAMING.flowTimeout } as Api.ApiError);
          } else {
            fail("stage", err);
          }
        });
    },
    [getSandboxId],
  );

  const beginPolling = useCallback(() => {
    if (!staged) return;
    const sandboxId = getSandboxId?.() ?? "";
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setPhase("POLLING");
    pollStart.current = Date.now();
    pushLog("→ polling sandbox for the Opsera report…");

    const tick = () => {
      Api.pollSandbox(sandboxId, staged.packageName, staged.version, ctrl.signal)
        .then((r) => {
          if (r.ready) {
            clearPoll();
            pushLog("Opsera report detected — normalized & stored in Tigris.", "ok");
            setResult({ record: r.scanRecord ?? null, report: r.report ?? null });
            setPhase("DONE");
            onComplete?.();
            return;
          }
          if (Date.now() - pollStart.current > POLL_MAX_MS) {
            fail("poll", {
              errorType: "TIMEOUT",
              message: "No Opsera report appeared in time. Did the scan finish in VS Code?",
            } as Api.ApiError);
            return;
          }
          pollTimer.current = setTimeout(tick, POLL_INTERVAL_MS);
        })
        .catch((err) => {
          if (Api.isAbortError(err)) return; // cancelled
          // transient poll error → keep trying until the max window
          if (Date.now() - pollStart.current > POLL_MAX_MS) {
            fail("poll", err);
          } else {
            pollTimer.current = setTimeout(tick, POLL_INTERVAL_MS);
          }
        });
    };
    tick();
  }, [staged, getSandboxId, onComplete]);

  const reset = useCallback(() => {
    clearPoll();
    ctrlRef.current?.abort();
    setPhase("IDLE");
    setStaged(null);
    setResult(null);
    setError(null);
    setLog([]);
  }, []);

  const busy = ["STAGING", "AWAITING_SCAN", "POLLING"].indexOf(phase) > -1;
  const polling = phase === "POLLING";
  const activeIndex =
    phase === "STAGING"
      ? 0
      : phase === "AWAITING_SCAN"
        ? 1
        : phase === "POLLING"
          ? 2
          : phase === "DONE"
            ? 4
            : 0;

  return {
    phase,
    target,
    staged,
    result,
    error,
    log,
    busy,
    polling,
    activeIndex,
    start,
    beginPolling,
    reset,
    cancel: reset,
  };
}

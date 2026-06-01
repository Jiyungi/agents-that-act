/* ============================================================
 * useScanFlow.ts — agentic scan flow (Daytona → Opsera → Tigris).
 *
 *   IDLE → SCANNING → DONE | ERROR
 *
 * A single POST /api/scan runs the whole pipeline server-side with NO human
 * step and NO file upload: an isolated Daytona sandbox fetches + unpacks the
 * package, Opsera's static scanners (Semgrep + Gitleaks) run inside it, and the
 * verdict + report land in Tigris. The UI just streams the step log and renders
 * the resulting verdict card.
 * ============================================================ */
import { useCallback, useRef, useState } from "react";
import type { ReportSchema, ScanRecord } from "@shared/contracts";
import * as Api from "./api";
import { FRAMING } from "./framing";
import type { LogLine } from "./components/ScanProgress";

export type Phase = "IDLE" | "SCANNING" | "DONE" | "ERROR";

export interface FlowError {
  phase: string;
  errorType: string;
  message: string;
  manualCommand?: string;
}

export interface ScanFlowResult {
  record: ScanRecord;
  report: ReportSchema | null;
}

export interface ScanFlow {
  phase: Phase;
  target: string;
  result: ScanFlowResult | null;
  error: FlowError | null;
  log: LogLine[];
  busy: boolean;
  activeIndex: number;
  start: (name: string) => void;
  reset: () => void;
  cancel: () => void;
}

const nowStamp = () => new Date().toTimeString().slice(0, 8);

export function useScanFlow(onComplete?: () => void): ScanFlow {
  const [phase, setPhase] = useState<Phase>("IDLE");
  const [target, setTarget] = useState("");
  const [result, setResult] = useState<ScanFlowResult | null>(null);
  const [error, setError] = useState<FlowError | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);

  const ctrlRef = useRef<AbortController | null>(null);

  const pushLog = (text: string, cls?: string) =>
    setLog((l) => l.concat([{ t: nowStamp(), text, cls }]));

  const fail = (ph: string, err: unknown) => {
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
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      setError(null);
      setResult(null);
      setTarget(name);
      setLog([]);
      setPhase("SCANNING");

      pushLog("$ packguard scan " + name, "ac");
      pushLog("→ POST /api/scan  { packageName }");
      pushLog("spinning up isolated Daytona sandbox…");
      pushLog("fetching + unpacking package (never installed)…");
      pushLog("running Opsera static scan (Semgrep + Gitleaks) in sandbox…");

      Api.scanPackage(name, ctrl.signal)
        .then(({ scanRecord, report, steps }) => {
          for (const s of steps) pushLog(s.message, s.phase === "DONE" ? "ok" : undefined);
          pushLog("verdict stored in Tigris", "ok");
          setResult({ record: scanRecord, report });
          setPhase("DONE");
          onComplete?.();
        })
        .catch((err) => {
          if (Api.isAbortError(err)) {
            fail("scan", { errorType: "TIMEOUT", message: FRAMING.flowTimeout } as Api.ApiError);
          } else {
            fail("scan", err);
          }
        });
    },
    [onComplete],
  );

  const reset = useCallback(() => {
    ctrlRef.current?.abort();
    setPhase("IDLE");
    setResult(null);
    setError(null);
    setLog([]);
  }, []);

  const busy = phase === "SCANNING";
  const activeIndex = phase === "SCANNING" ? 1 : phase === "DONE" ? 4 : 0;

  return {
    phase,
    target,
    result,
    error,
    log,
    busy,
    activeIndex,
    start,
    reset,
    cancel: reset,
  };
}

/* ============================================================
 * useScanFlow.ts — explicit scan-flow state machine (§5).
 *
 *   IDLE → RESOLVING → FETCHING → AWAITING_SCAN → UPLOADING → DONE | ERROR
 *
 * The ScanResultContract returned by /local/fetch is held in state across the
 * manual handoff pause (the operator runs /security-scan), then the upload
 * trigger fetches + renders the normalized report.
 * ============================================================ */
import { useCallback, useRef, useState } from "react";
import type { ReportSchema, ScanRecord, ScanResultContract } from "@shared/contracts";
import * as Api from "./api";
import { FRAMING } from "./framing";
import type { LogLine } from "./components/ScanProgress";

export type Phase =
  | "IDLE"
  | "RESOLVING"
  | "FETCHING"
  | "AWAITING_SCAN"
  | "UPLOADING"
  | "DONE"
  | "ERROR";

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
  contract: ScanResultContract | null;
  result: ScanFlowResult | null;
  error: FlowError | null;
  log: LogLine[];
  busy: boolean;
  uploading: boolean;
  activeIndex: number;
  start: (name: string) => void;
  upload: () => void;
  reset: () => void;
  cancel: () => void;
}

const nowStamp = () => new Date().toTimeString().slice(0, 8);

export function useScanFlow(onComplete?: () => void): ScanFlow {
  const [phase, setPhase] = useState<Phase>("IDLE");
  const [target, setTarget] = useState("");
  const [contract, setContract] = useState<ScanResultContract | null>(null);
  const [result, setResult] = useState<ScanFlowResult | null>(null);
  const [error, setError] = useState<FlowError | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);

  const ctrlRef = useRef<AbortController | null>(null);
  const flowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // tracks which phase we are in when an abort fires, for accurate error labels
  const phaseRef = useRef<string>("resolve");

  const pushLog = (text: string, cls?: string) =>
    setLog((l) => l.concat([{ t: nowStamp(), text, cls }]));

  const clearFlowTimer = () => {
    if (flowTimer.current) {
      clearTimeout(flowTimer.current);
      flowTimer.current = null;
    }
  };

  const fail = (ph: string, err: unknown) => {
    clearFlowTimer();
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
      clearFlowTimer();
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      setError(null);
      setResult(null);
      setContract(null);
      setTarget(name);
      setLog([]);
      setPhase("RESOLVING");
      phaseRef.current = "resolve";

      // §6 overall flow timeout: abort everything at 30s
      flowTimer.current = setTimeout(() => ctrl.abort(), Api.T_FLOW);

      pushLog("$ packguard scan " + name, "ac");
      pushLog("→ POST /api/resolve  { packageName }");

      Api.resolvePackage(name, ctrl.signal)
        .then((resolved) => {
          pushLog("resolved " + resolved.packageName + "@" + resolved.version, "ok");
          const tail = resolved.tarballUrl.split("/-/")[1];
          if (tail) pushLog("↓ " + tail);
          pushLog("→ POST 127.0.0.1:3939/local/fetch");
          phaseRef.current = "fetch";
          setPhase("FETCHING");
          return Api.fetchAndLaunch(resolved, ctrl.signal);
        })
        .then((c) => {
          pushLog("extract ./scan-target  (sandboxed — never installed)", "ok");
          pushLog("code ./scan-target  → opened in VS Code", "ac");
          setContract(c);
          setPhase("AWAITING_SCAN");
          phaseRef.current = "scan";
          clearFlowTimer(); // pause is durable; stop the 30s flow clock here
        })
        .catch((err) => {
          if (Api.isAbortError(err)) {
            fail(phaseRef.current, {
              errorType: "TIMEOUT",
              message: FRAMING.flowTimeout,
            } as Api.ApiError);
          } else {
            fail(phaseRef.current, err);
          }
        });
    },
    [],
  );

  const upload = useCallback(() => {
    if (!contract) return;
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setPhase("UPLOADING");
    phaseRef.current = "upload";
    pushLog("→ POST 127.0.0.1:3939/local/upload  { uploadId }");
    const to = setTimeout(() => ctrl.abort(), Api.T_FLOW);

    Api.uploadReport(contract.packageName, contract.version, ctrl.signal)
      .then((record) => {
        pushLog("report normalized, scored & published", "ok");
        return Api.getReport(record, ctrl.signal).then((report) => ({ record, report }));
      })
      .then(({ record, report }) => {
        clearTimeout(to);
        setResult({ record, report });
        setPhase("DONE");
        onComplete?.();
      })
      .catch((err) => {
        clearTimeout(to);
        if (Api.isAbortError(err)) {
          fail("upload", {
            errorType: "TIMEOUT",
            message: FRAMING.flowTimeout,
          } as Api.ApiError);
        } else {
          fail("upload", err);
        }
      });
  }, [contract, onComplete]);

  const reset = useCallback(() => {
    clearFlowTimer();
    ctrlRef.current?.abort();
    setPhase("IDLE");
    setContract(null);
    setResult(null);
    setError(null);
    setLog([]);
  }, []);

  const busy = ["RESOLVING", "FETCHING", "AWAITING_SCAN", "UPLOADING"].indexOf(phase) > -1;
  const uploading = phase === "UPLOADING";
  const activeIndex =
    phase === "RESOLVING"
      ? 0
      : phase === "FETCHING"
        ? 1
        : phase === "AWAITING_SCAN"
          ? 2
          : phase === "UPLOADING"
            ? 3
            : phase === "DONE"
              ? 4
              : 0;

  return {
    phase,
    target,
    contract,
    result,
    error,
    log,
    busy,
    uploading,
    activeIndex,
    start,
    upload,
    reset,
    cancel: reset,
  };
}

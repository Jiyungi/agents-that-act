/* ScanProgress — 4-phase progress affordance + live console log (§10). */
import { useEffect, useRef } from "react";
import { Icons } from "./Icons";
import { PHASES } from "../framing";

export interface LogLine {
  t: string;
  text: string;
  cls?: string;
}

interface ScanProgressProps {
  target: string;
  activeIndex: number;
  errorIndex: number | null;
  logLines: LogLine[];
}

export function ScanProgress({ target, activeIndex, errorIndex, logLines }: ScanProgressProps) {
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logLines]);

  return (
    <div className="progress fade-in" role="group" aria-label="Scan progress">
      <div className="progress-head">
        <Icons.box size={14} />
        <span>scanning</span>
        <span className="target">{target}</span>
      </div>
      <div className="progress-steps">
        {PHASES.map((p, i) => {
          let cls = "pstep";
          if (errorIndex === i) cls += " error";
          else if (i < activeIndex) cls += " done";
          else if (i === activeIndex) cls += " active";
          return (
            <div key={p.key} className={cls} aria-current={i === activeIndex ? "step" : undefined}>
              <div className="pnum">
                {i < activeIndex && errorIndex == null ? (
                  <Icons.check size={13} />
                ) : errorIndex === i ? (
                  "!"
                ) : (
                  i + 1
                )}
              </div>
              <div className="pname">{p.name}</div>
              <div className="pdesc">{p.desc}</div>
            </div>
          );
        })}
      </div>
      {logLines.length > 0 && (
        <div className="console" ref={logRef} aria-hidden="true">
          {logLines.map((l, i) => (
            <div key={i} className={"ln" + (i === logLines.length - 1 ? " cur" : "")}>
              <span className="t">{l.t} </span>
              <span className={l.cls || ""}>{l.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

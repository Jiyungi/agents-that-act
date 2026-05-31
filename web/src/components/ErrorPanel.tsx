/* ErrorPanel — typed failure surface with optional manual-command recovery. */
import { useState } from "react";
import { Icons } from "./Icons";

interface ErrorPanelProps {
  phase?: string;
  errorType: string;
  message: string;
  manualCommand?: string;
  onRetry: () => void;
  onDismiss: () => void;
}

export function ErrorPanel({
  phase,
  errorType,
  message,
  manualCommand,
  onRetry,
  onDismiss,
}: ErrorPanelProps) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (manualCommand && navigator.clipboard) {
      navigator.clipboard.writeText(manualCommand).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      });
    }
  };
  return (
    <div className="errpanel fade-in" role="alert">
      <div className="errpanel-head">
        <span className="e-ico">
          <Icons.alert size={18} />
        </span>
        <span className="e-type">{errorType}</span>
        {phase && <span className="e-phase">phase: {phase}</span>}
      </div>
      <div className="errpanel-body">
        <div className="e-msg">{message}</div>
        {manualCommand && (
          <div className="e-manual">
            <div className="em-label">Run this to open the package folder manually:</div>
            <div className="em-cmd">
              <span className="em-text">{manualCommand}</span>
              <button className={"copy-btn" + (copied ? " copied" : "")} onClick={copy}>
                {copied ? "copied" : <Icons.copy size={13} />}
              </button>
            </div>
          </div>
        )}
        <div className="btn-row" style={{ marginTop: 16 }}>
          <button className="btn btn-primary" onClick={onRetry}>
            <Icons.refresh size={14} /> Try again
          </button>
          <button className="btn btn-ghost" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

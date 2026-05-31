/* ManualHandoffPanel — the durable pause where the operator runs /security-scan (§5.3). */
import type { ScanResultContract } from "@shared/contracts";
import { Icons } from "./Icons";
import { FRAMING } from "../framing";

interface ManualHandoffPanelProps {
  contract: ScanResultContract;
  busy: boolean;
  onUpload: () => void;
  onCancel: () => void;
}

export function ManualHandoffPanel({
  contract,
  busy,
  onUpload,
  onCancel,
}: ManualHandoffPanelProps) {
  return (
    <div className="handoff fade-in" role="region" aria-label={FRAMING.handoffTitle}>
      <div className="handoff-head">
        <span className="h-badge">{FRAMING.handoffBadge}</span>
        <h3>{FRAMING.handoffTitle}</h3>
        <span className="pause-dot">
          <i></i> awaiting scan
        </span>
      </div>
      <div className="handoff-body">
        <ol className="handoff-steps">
          <li>{FRAMING.handoffStep1}</li>
          <li dangerouslySetInnerHTML={{ __html: FRAMING.handoffStep2html }} />
          <li dangerouslySetInnerHTML={{ __html: FRAMING.handoffStep3html }} />
        </ol>
        <div className="kv">
          <span className="k">package</span>
          <span className="v">
            {contract.packageName}
            <span style={{ color: "var(--text-ghost)" }}>@</span>
            {contract.version}
          </span>
          <span className="k">source</span>
          <span className="v path">{contract.sourcePath}</span>
          <span className="k">report</span>
          <span className="v path">{contract.reportPath}</span>
        </div>
        <div className="btn-row">
          <button className="btn btn-primary" onClick={onUpload} disabled={busy} aria-busy={busy}>
            {busy ? (
              <>
                <span className="spin">
                  <Icons.refresh size={14} />
                </span>{" "}
                Uploading…
              </>
            ) : (
              <>
                <Icons.upload size={15} /> Upload report
              </>
            )}
          </button>
          <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

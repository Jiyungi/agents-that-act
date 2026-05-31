/* AgentHealthBanner — non-blocking local-agent status banner (§5). */
import { useState } from "react";
import type { AgentHealth } from "../api";
import { Icons } from "./Icons";
import { FRAMING } from "../framing";

interface AgentHealthBannerProps {
  health: AgentHealth | null;
  onRetry: () => void;
}

export function AgentHealthBanner({ health, onRetry }: AgentHealthBannerProps) {
  const [dismissed, setDismissed] = useState(false);
  // Only surface a banner for non-OK states (non-blocking).
  if (!health || health.reachable === undefined) return null;
  const down = !health.reachable;
  const noCode = health.reachable && !health.codeCliAvailable;
  if (!down && !noCode) return null;
  if (dismissed && noCode) return null; // allow dismissing the soft warning

  const msg = down ? FRAMING.agentMissing : FRAMING.agentNoCode;
  // split copy at backtick to render the command as <code>
  const parts = msg.split(/`([^`]+)`/);
  return (
    <div className={"banner fade-in " + (down ? "off" : "")} role="status">
      <span className="b-ico">
        <Icons.alert size={16} />
      </span>
      <div>
        {parts.map((p, i) => (i % 2 ? <code key={i}>{p}</code> : <span key={i}>{p}</span>))}
        {down && (
          <button
            className="copy-btn"
            style={{ marginLeft: 10, verticalAlign: "middle" }}
            onClick={onRetry}
          >
            retry
          </button>
        )}
      </div>
      {noCode && (
        <button className="b-close" aria-label="Dismiss" onClick={() => setDismissed(true)}>
          ×
        </button>
      )}
    </div>
  );
}

interface AgentPillProps {
  health: AgentHealth | null;
  onClick: () => void;
}

export function AgentPill({ health, onClick }: AgentPillProps) {
  let cls = "checking";
  let label: string = FRAMING.agentChecking;
  if (health && health.reachable === false) {
    cls = "off";
    label = "Agent offline";
  } else if (health && health.reachable === true && !health.codeCliAvailable) {
    cls = "warn";
    label = "Agent · no code CLI";
  } else if (health && health.reachable === true) {
    cls = "ok";
    label = FRAMING.agentOk;
  }
  return (
    <button
      className={"agent-pill " + cls}
      onClick={onClick}
      title="Local agent · http://127.0.0.1:3939"
    >
      <span className="dot"></span>
      {label}
    </button>
  );
}

/* ============================================================
 * TweaksPanel.tsx — demo-only control panel (mock mode).
 *
 * Lets you preview every contract state (verdict style, agent health, gallery
 * states) without a backend. It is only mounted when the API client runs in
 * mock mode, so production builds against the real backend never show it.
 * ============================================================ */
import { Icons } from "./Icons";

interface SegmentedOption<T extends string> {
  v: T;
  label: string;
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (v: T) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        border: "1px solid var(--border-bright)",
        borderRadius: 4,
        overflow: "hidden",
      }}
    >
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          style={{
            flex: 1,
            padding: "7px 8px",
            fontFamily: "var(--mono)",
            fontSize: 11.5,
            cursor: "pointer",
            border: "none",
            borderRight: "1px solid var(--border)",
            background: value === o.v ? "var(--accent)" : "var(--panel-2)",
            color: value === o.v ? "#fff" : "var(--text-dim)",
            fontWeight: value === o.v ? 700 : 400,
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function TwRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 11, color: "var(--text-faint)", marginBottom: 7, letterSpacing: 0.3 }}>
        {label}
      </div>
      {children}
    </div>
  );
}

export type VariantPref = "panel" | "console";
export type AgentSim = "ok" | "no-code" | "down";
export type GallerySim = "ok" | "partial" | "empty" | "unavailable";

export interface TweaksPrefs {
  variant: VariantPref;
  setVariant: (v: VariantPref) => void;
  scan: number;
  setScan: (v: number) => void;
  agent: AgentSim;
  setAgent: (v: AgentSim) => void;
  gallery: GallerySim;
  setGallery: (v: GallerySim) => void;
}

export function TweaksPanel({
  open,
  onClose,
  prefs,
}: {
  open: boolean;
  onClose: () => void;
  prefs: TweaksPrefs;
}) {
  if (!open) return null;
  const { variant, setVariant, scan, setScan, agent, setAgent, gallery, setGallery } = prefs;
  return (
    <div
      style={{
        position: "fixed",
        right: 18,
        bottom: 70,
        zIndex: 60,
        width: 290,
        background: "var(--panel)",
        border: "1px solid var(--border-bright)",
        borderRadius: 6,
        boxShadow: "0 18px 60px rgba(0,0,0,0.55)",
        padding: 16,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: 0.5 }}>
          <span style={{ color: "var(--accent-bright)" }}>~/</span>tweaks
        </span>
        <button className="b-close" style={{ marginLeft: "auto", fontSize: 16 }} onClick={onClose}>
          ×
        </button>
      </div>

      <TwRow label="VERDICT CARD STYLE">
        <Segmented
          value={variant}
          onChange={setVariant}
          options={[
            { v: "panel", label: "Panel" },
            { v: "console", label: "Console" },
          ]}
        />
      </TwRow>

      <TwRow label={"SCANLINE INTENSITY · " + Math.round(scan * 100) + "%"}>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={scan}
          onChange={(e) => setScan(parseFloat(e.target.value))}
          style={{ width: "100%", accentColor: "var(--accent)" }}
        />
      </TwRow>

      <TwRow label="SIMULATE LOCAL AGENT">
        <Segmented
          value={agent}
          onChange={setAgent}
          options={[
            { v: "ok", label: "OK" },
            { v: "no-code", label: "No CLI" },
            { v: "down", label: "Down" },
          ]}
        />
      </TwRow>

      <TwRow label="GALLERY STATE">
        <Segmented
          value={gallery}
          onChange={setGallery}
          options={[
            { v: "ok", label: "OK" },
            { v: "partial", label: "Partial" },
            { v: "empty", label: "Empty" },
            { v: "unavailable", label: "Down" },
          ]}
        />
      </TwRow>

      <div style={{ fontSize: 10.5, color: "var(--text-ghost)", lineHeight: 1.5, marginTop: 4 }}>
        Preview every contract state. Try scanning{" "}
        <b style={{ color: "var(--text-faint)" }}>does-not-exist-pkg</b> or{" "}
        <b style={{ color: "var(--text-faint)" }}>no-vscode</b> for error states.
      </div>

      <div style={{ fontSize: 10, color: "var(--text-ghost)", marginTop: 10, display: "flex", gap: 6, alignItems: "center" }}>
        <Icons.info size={11} /> Mock mode — wired to fixtures, not a live backend.
      </div>
    </div>
  );
}

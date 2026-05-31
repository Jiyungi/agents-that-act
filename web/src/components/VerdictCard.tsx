/* ============================================================
 * VerdictCard.tsx — verdict card (panel + console variants),
 * FindingItem, severity badges, score gauge, shareable link, disclaimer.
 * §7 + §8 rules enforced here; all copy from `framing.ts`.
 * ============================================================ */
import { useState } from "react";
import type { Finding, ReportSchema, ScanRecord, Severity, Verdict } from "@shared/contracts";
import { Icons } from "./Icons";
import { FRAMING } from "../framing";
import { THRESHOLD } from "../mock/data";

const SEV_ORDER: Record<Severity, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };

function sortFindings(findings: Finding[]): Finding[] {
  return (findings || [])
    .slice()
    .sort((a, b) => (SEV_ORDER[b.severity] || 0) - (SEV_ORDER[a.severity] || 0));
}

/* ---- severity badge (never color-alone: word + level bars) ---- */
function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span className={"sev-badge sev-" + severity} title={severity + " severity"}>
      <span className="sb-bar" aria-hidden="true">
        <i></i>
        <i></i>
        <i></i>
        <i></i>
      </span>
      {severity}
    </span>
  );
}

/* ---- score gauge ring ---- */
function Gauge({ score, verdict }: { score: number; verdict: Verdict }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, score)) / 100;
  const color = verdict === "SAFE" ? "var(--safe)" : "var(--risky)";
  return (
    <div className="gauge" aria-hidden="true">
      <svg width="64" height="64">
        <circle cx="32" cy="32" r={r} fill="none" stroke="var(--panel-3)" strokeWidth="6" />
        <circle
          cx="32"
          cy="32"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - p)}
          style={{ transition: "stroke-dashoffset .9s cubic-bezier(.2,.7,.2,1)" }}
        />
      </svg>
      <div className="g-num" style={{ color }}>
        {score}
      </div>
    </div>
  );
}

/* ---- code snippet block (the referenced source line) ---- */
function CodeSnippet({ finding }: { finding: Finding }) {
  const hasLine = finding.lineNumber && finding.lineNumber > 0;
  const lineLabel = hasLine ? "line " + finding.lineNumber : FRAMING.unspecifiedLine;
  if (!finding.codeSnippet) {
    return (
      <div className="code-block">
        <div className="cb-head">
          <Icons.code size={12} />
          <span className="fp">{finding.filePath}</span>
          <span className="ln-no">{lineLabel}</span>
        </div>
        <div className="code-unavailable">{FRAMING.sourceLineUnavailable}</div>
      </div>
    );
  }
  return (
    <div className="code-block">
      <div className="cb-head">
        <Icons.code size={12} />
        <span className="fp">{finding.filePath}</span>
        <span className="ln-no">{lineLabel}</span>
      </div>
      <pre>
        <code>
          <span className="code-line hl">
            <span className="gutter">
              {hasLine ? String(finding.lineNumber).padStart(3, " ") : "  ·"}
            </span>
            {finding.codeSnippet}
          </span>
        </code>
      </pre>
    </div>
  );
}

/* ---- one finding (expandable) ---- */
export function FindingItem({
  finding,
  defaultOpen,
}: {
  finding: Finding;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const hasLine = finding.lineNumber && finding.lineNumber > 0;
  return (
    <div className={"finding" + (open ? " open" : "")}>
      <div
        className="finding-top"
        onClick={() => setOpen(!open)}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(!open);
          }
        }}
      >
        <SeverityBadge severity={finding.severity} />
        <span className="finding-cat">{finding.category}</span>
        <span className="finding-loc">
          <span className="fp">{finding.filePath}</span>
          {" : "}
          {hasLine ? finding.lineNumber : FRAMING.unspecifiedLine}
        </span>
        <span className="finding-chev">
          <Icons.chevron size={15} />
        </span>
      </div>
      <div className="finding-body">
        <CodeSnippet finding={finding} />
      </div>
    </div>
  );
}

/* ---- shareable link ---- */
function ShareLink({ url }: { url: string | null }) {
  const [copied, setCopied] = useState(false);
  if (!url) {
    return (
      <div className="v-foot">
        <span className="vf-label">{FRAMING.shareLabel}</span>
        <span className="share share-disabled">
          <Icons.info size={13} /> {FRAMING.shareUnavailable}
        </span>
      </div>
    );
  }
  const copy = () => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      });
    }
  };
  return (
    <div className="v-foot">
      <span className="vf-label">{FRAMING.shareLabel}</span>
      <span className="share">
        <Icons.ext size={13} />
        <a
          className="url"
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "inherit", textDecoration: "none" }}
        >
          {url}
        </a>
      </span>
      <button className={"copy-btn" + (copied ? " copied" : "")} onClick={copy}>
        {copied ? (
          "copied!"
        ) : (
          <>
            <Icons.copy size={12} /> copy
          </>
        )}
      </button>
    </div>
  );
}

/* ---- disclaimer strip (honest framing, §8) ---- */
export function Disclaimer() {
  return (
    <div className="disclaimer">
      <span className="d-ico">
        <Icons.info size={14} />
      </span>
      <span>{FRAMING.disclaimer}</span>
    </div>
  );
}

/* ---- findings region (shared by both variants) ---- */
function FindingsRegion({ report }: { report: ReportSchema }) {
  const findings = sortFindings(report.findings);
  if (report.verdict === "SAFE" && findings.length === 0) {
    return (
      <div className="findings">
        <div className="no-findings">
          <div className="nf-ico">
            <Icons.check size={26} />
          </div>
          {FRAMING.noFindings}
        </div>
      </div>
    );
  }
  const counts = findings.reduce<Record<string, number>>((m, f) => {
    m[f.severity] = (m[f.severity] || 0) + 1;
    return m;
  }, {});
  const order: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
  return (
    <div className="findings">
      <div className="findings-head">
        <Icons.alert size={13} />
        <span className="count">{findings.length}</span>
        <span>finding{findings.length === 1 ? "" : "s"}</span>
        <span className="legend">
          {order
            .filter((s) => counts[s])
            .map((s) => (
              <span key={s} style={{ color: `var(--sev-${s.toLowerCase()})` }}>
                {counts[s]} {s.toLowerCase()}
              </span>
            ))}
        </span>
      </div>
      {findings.map((f, i) => (
        <FindingItem key={i} finding={f} defaultOpen={i === 0} />
      ))}
    </div>
  );
}

export type VerdictVariant = "panel" | "console";

interface VerdictCardProps {
  report: ReportSchema | null;
  record: ScanRecord | null;
  variant: VerdictVariant;
}

/* =====================================================================
 * VerdictCard — variant 'panel' (default) and 'console'
 * ===================================================================*/
export function VerdictCard({ report, record, variant }: VerdictCardProps) {
  // No report available at all (§7)
  if (!report && !record) {
    return (
      <div className="verdict fade-in" style={{ border: "1px solid var(--border-bright)" }}>
        <div className="no-findings" style={{ padding: "34px 20px" }}>
          <div className="nf-ico" style={{ color: "var(--text-faint)" }}>
            <Icons.info size={26} />
          </div>
          {FRAMING.noReport}
        </div>
      </div>
    );
  }
  // Render from report when present, else from record fields (§5.4 fallback)
  const verdict: Verdict = report ? report.verdict : record!.verdict;
  const score = report ? report.riskScore : record!.riskScore;
  const name = report ? report.packageName : record!.packageName;
  const version = report ? report.version : record!.version;
  const threshold = record && record.thresholdUsed != null ? record.thresholdUsed : THRESHOLD;
  const url = record ? record.publicReportUrl : null;
  const isSafe = verdict === "SAFE";

  if (variant === "console") {
    return (
      <VerdictConsole
        {...{ report, verdict, score, name, version, threshold, url, isSafe }}
      />
    );
  }

  const derivation = isSafe ? (
    <>
      score <b>{score}</b> &lt; threshold <b>{threshold}</b> → <b className="safe">SAFE</b>.{" "}
      {FRAMING.safeBlurb}
    </>
  ) : (
    <>
      score <b>{score}</b> ≥ threshold <b>{threshold}</b> → <b className="risky">RISKY</b>.{" "}
      {FRAMING.riskyBlurb}
    </>
  );

  // ---------- variant: PANEL ----------
  return (
    <div
      className={"verdict fade-in " + (isSafe ? "safe" : "risky")}
      role="region"
      aria-label="Scan verdict"
    >
      <div className="v-head">
        <div className="v-stamp">
          <span className="v-icon">
            {isSafe ? <Icons.shield size={26} /> : <Icons.alert size={26} />}
          </span>
          <span className="v-label">verdict</span>
          <span className="v-word">{verdict}</span>
        </div>
        <div className="v-meta">
          <div className="v-pkg">
            <span className="name">{name}</span>
            <span className="ver">{version}</span>
          </div>
          <div className="v-attr">
            {FRAMING.resultsLabel}. {FRAMING.attribution}
          </div>
          <div className="v-score">
            <Gauge score={score} verdict={verdict} />
            <div className="score-bar-wrap">
              <div className="score-bar-top">
                <span>risk score</span>
                <span>{score} / 100</span>
              </div>
              <div className="score-bar">
                <i style={{ width: score + "%" }}></i>
                <span className="score-thresh" style={{ left: threshold + "%" }}></span>
              </div>
              <div className="score-derive">{derivation}</div>
            </div>
          </div>
        </div>
      </div>
      {report ? (
        <FindingsRegion report={report} />
      ) : (
        <div className="findings">
          <div className="no-findings" style={{ padding: "22px" }}>
            <div className="nf-ico" style={{ color: "var(--text-faint)" }}>
              <Icons.info size={22} />
            </div>
            {FRAMING.noReport}
          </div>
        </div>
      )}
      <ShareLink url={url} />
    </div>
  );
}

/* ---------- variant: CONSOLE (terminal report) ---------- */
interface VerdictConsoleProps {
  report: ReportSchema | null;
  verdict: Verdict;
  score: number;
  name: string;
  version: string;
  threshold: number;
  url: string | null;
  isSafe: boolean;
}

function VerdictConsole({
  report,
  verdict,
  score,
  name,
  version,
  threshold,
  url,
  isSafe,
}: VerdictConsoleProps) {
  const color = isSafe ? "var(--safe)" : "var(--risky)";
  return (
    <div
      className={"verdict fade-in " + (isSafe ? "safe" : "risky")}
      role="region"
      aria-label="Scan verdict"
    >
      <div
        style={{ background: "#050609", padding: "18px 20px", borderBottom: "1px solid var(--border)" }}
      >
        <div style={{ fontSize: 12, color: "var(--text-faint)" }}>
          <span style={{ color: "var(--accent-bright)" }}>packguard</span> verdict —{" "}
          <span style={{ color: "var(--text-dim)" }}>
            {name}@{version}
          </span>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            marginTop: 14,
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              color,
              fontSize: 30,
              fontWeight: 700,
              display: "inline-flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            {isSafe ? <Icons.shield size={24} /> : <Icons.alert size={24} />}[ {verdict} ]
          </span>
          <span style={{ fontSize: 12, color: "var(--text-faint)" }}>
            risk_score = <b style={{ color: "var(--text)" }}>{score}</b> / 100 &nbsp;·&nbsp;
            threshold = {threshold}
          </span>
        </div>
        <div style={{ marginTop: 12 }}>
          <div className="score-bar" style={{ maxWidth: 420 }}>
            <i
              style={{
                width: score + "%",
                background: isSafe
                  ? "linear-gradient(90deg,var(--safe),#6ee7b7)"
                  : "linear-gradient(90deg,var(--sev-high),var(--risky))",
              }}
            ></i>
            <span className="score-thresh" style={{ left: threshold + "%" }}></span>
          </div>
          <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginTop: 9 }}>
            {isSafe ? (
              <>
                <span style={{ color: "var(--text-faint)" }}>{"// "}</span>
                {score} &lt; {threshold} → resolved <b style={{ color: "var(--safe)" }}>SAFE</b>.{" "}
                {FRAMING.safeBlurb}
              </>
            ) : (
              <>
                <span style={{ color: "var(--text-faint)" }}>{"// "}</span>
                {score} ≥ {threshold} → resolved <b style={{ color: "var(--risky)" }}>RISKY</b>.{" "}
                {FRAMING.riskyBlurb}
              </>
            )}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 8 }}>
            {FRAMING.attributionShort}
          </div>
        </div>
      </div>
      {report ? (
        <FindingsRegion report={report} />
      ) : (
        <div className="findings">
          <div className="no-findings" style={{ padding: "22px" }}>
            {FRAMING.noReport}
          </div>
        </div>
      )}
      <ShareLink url={url} />
    </div>
  );
}

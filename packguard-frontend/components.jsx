/* ============================================================
 * components.jsx — icons + flow/shell components
 * SearchBar, ScanProgress, ManualHandoffPanel, AgentHealthBanner,
 * ErrorPanel, Gallery, GalleryEntry.
 * Exported to window for cross-script use (see bottom).
 * ============================================================ */
const { useState, useEffect, useRef } = React;
const F = window.FRAMING;

/* ---------------- icons (inline, stroke-based) ---------------- */
function Ico({ d, size = 16, fill = "none", vb = 24, sw = 1.75, children, style }) {
  return (
    <svg width={size} height={size} viewBox={`0 0 ${vb} ${vb}`} fill={fill}
      stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" style={style}>
      {d ? <path d={d} /> : children}
    </svg>
  );
}
const Icons = {
  shield: (p) => <Ico {...p} d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />,
  check:  (p) => <Ico {...p} d="M20 6L9 17l-5-5" />,
  alert:  (p) => <Ico {...p}><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></Ico>,
  search: (p) => <Ico {...p}><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></Ico>,
  chevron:(p) => <Ico {...p} d="M9 6l6 6-6 6" />,
  arrow:  (p) => <Ico {...p} d="M5 12h14M13 6l6 6-6 6" />,
  ext:    (p) => <Ico {...p}><path d="M15 3h6v6"/><path d="M10 14L21 3"/><path d="M21 14v5a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h5"/></Ico>,
  copy:   (p) => <Ico {...p}><rect x="9" y="9" width="11" height="11" rx="1.5"/><path d="M5 15V5a2 2 0 012-2h10"/></Ico>,
  info:   (p) => <Ico {...p}><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></Ico>,
  box:    (p) => <Ico {...p}><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></Ico>,
  code:   (p) => <Ico {...p} d="M8 6l-6 6 6 6M16 6l6 6-6 6" />,
  upload: (p) => <Ico {...p}><path d="M12 16V4M6 10l6-6 6 6"/><path d="M4 20h16"/></Ico>,
  zap:    (p) => <Ico {...p} d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />,
  refresh:(p) => <Ico {...p}><path d="M21 12a9 9 0 11-3-6.7L21 8"/><path d="M21 3v5h-5"/></Ico>,
};

/* ---------------- AgentHealthBanner ---------------- */
function AgentHealthBanner({ health, onRetry }) {
  const [dismissed, setDismissed] = useState(false);
  // Only surface a banner for non-OK states (non-blocking).
  if (!health || health.reachable === undefined) return null;
  const down = !health.reachable;
  const noCode = health.reachable && !health.codeCliAvailable;
  if (!down && !noCode) return null;
  if (dismissed && noCode) return null; // allow dismissing the soft warning

  const msg = down ? F.agentMissing : F.agentNoCode;
  // split copy at backtick to render the command as <code>
  const parts = msg.split(/`([^`]+)`/);
  return (
    <div className={"banner fade-in " + (down ? "off" : "")} role="status">
      <span className="b-ico"><Icons.alert size={16} /></span>
      <div>
        {parts.map((p, i) => i % 2 ? <code key={i}>{p}</code> : <span key={i}>{p}</span>)}
        {down && (
          <button className="copy-btn" style={{ marginLeft: 10, verticalAlign: "middle" }} onClick={onRetry}>
            retry
          </button>
        )}
      </div>
      {noCode && <button className="b-close" aria-label="Dismiss" onClick={() => setDismissed(true)}>×</button>}
    </div>
  );
}

/* ---------------- SearchBar ---------------- */
function SearchBar({ value, onChange, onSubmit, busy, error }) {
  const inputRef = useRef(null);
  const examples = ["event-stream", "chalk", "left-pad", "colors", "lodash"];
  return (
    <div className="search-wrap">
      <form
        className="search-box-form"
        onSubmit={(e) => { e.preventDefault(); onSubmit(); }}
      >
        <div className={"search-box" + (error ? " invalid" : "")}>
          <span className="search-prompt" aria-hidden="true">$</span>
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="npm package name  ·  e.g. event-stream or @scope/name"
            aria-label="npm package name"
            aria-invalid={!!error}
            aria-describedby="search-msg"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            maxLength={214}
            disabled={false}
          />
          <button className="scan-btn" type="submit" disabled={busy} aria-busy={busy}>
            {busy
              ? <><span className="spin"><Icons.refresh size={13} /></span> SCANNING</>
              : <><Icons.search size={14} /> SCAN</>}
          </button>
        </div>
      </form>
      <div id="search-msg" className={"search-msg" + (error ? " err" : "")} role={error ? "alert" : undefined} aria-live="assertive">
        {error || ""}
      </div>
      <div className="search-hint">
        <b>try:</b>{" "}
        {examples.map((ex) => (
          <span key={ex} className="chip" onClick={() => { onChange(ex); inputRef.current && inputRef.current.focus(); }}>
            {ex}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ---------------- ScanProgress (4-phase) ---------------- */
// phaseIndex: 0..3 active; status: 'active' | 'done' | 'error'
function ScanProgress({ target, activeIndex, errorIndex, logLines }) {
  const phases = window.PHASES;
  const logRef = useRef(null);
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
        {phases.map((p, i) => {
          let cls = "pstep";
          if (errorIndex === i) cls += " error";
          else if (i < activeIndex) cls += " done";
          else if (i === activeIndex) cls += " active";
          return (
            <div key={p.key} className={cls} aria-current={i === activeIndex ? "step" : undefined}>
              <div className="pnum">
                {i < activeIndex && errorIndex == null
                  ? <Icons.check size={13} />
                  : (errorIndex === i ? "!" : i + 1)}
              </div>
              <div className="pname">{p.name}</div>
              <div className="pdesc">{p.desc}</div>
            </div>
          );
        })}
      </div>
      {logLines && logLines.length > 0 && (
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

/* ---------------- ManualHandoffPanel ---------------- */
function ManualHandoffPanel({ contract, busy, onUpload, onCancel }) {
  return (
    <div className="handoff fade-in" role="region" aria-label={F.handoffTitle}>
      <div className="handoff-head">
        <span className="h-badge">{F.handoffBadge}</span>
        <h3>{F.handoffTitle}</h3>
        <span className="pause-dot"><i></i> awaiting scan</span>
      </div>
      <div className="handoff-body">
        <ol className="handoff-steps">
          <li>{F.handoffStep1}</li>
          <li dangerouslySetInnerHTML={{ __html: F.handoffStep2html }} />
          <li dangerouslySetInnerHTML={{ __html: F.handoffStep3html }} />
        </ol>
        <div className="kv">
          <span className="k">package</span>
          <span className="v">{contract.packageName}<span style={{ color: "var(--text-ghost)" }}>@</span>{contract.version}</span>
          <span className="k">source</span>
          <span className="v path">{contract.sourcePath}</span>
          <span className="k">report</span>
          <span className="v path">{contract.reportPath}</span>
        </div>
        <div className="btn-row">
          <button className="btn btn-primary" onClick={onUpload} disabled={busy} aria-busy={busy}>
            {busy ? <><span className="spin"><Icons.refresh size={14} /></span> Uploading…</> : <><Icons.upload size={15} /> Upload report</>}
          </button>
          <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- ErrorPanel ---------------- */
function ErrorPanel({ phase, errorType, message, manualCommand, onRetry, onDismiss }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard && navigator.clipboard.writeText(manualCommand).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 1400);
    });
  };
  return (
    <div className="errpanel fade-in" role="alert">
      <div className="errpanel-head">
        <span className="e-ico"><Icons.alert size={18} /></span>
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
          <button className="btn btn-primary" onClick={onRetry}><Icons.refresh size={14} /> Try again</button>
          <button className="btn btn-ghost" onClick={onDismiss}>Dismiss</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Gallery ---------------- */
function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60); if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60); if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24); return d + "d ago";
}

function GalleryEntry({ rec }) {
  const hasUrl = !!rec.publicReportUrl;
  const inner = (
    <>
      <div className="ge-pkg">
        <div className="ge-name">
          {rec.packageName}
          {hasUrl && <span className="ext"><Icons.ext size={12} /></span>}
        </div>
        <div className="ge-ver">{rec.version}</div>
      </div>
      <span className="ge-time">{timeAgo(rec.createdAt)}</span>
      <span className="ge-score">risk <b>{rec.riskScore}</b><span style={{ color: "var(--text-ghost)" }}>/100</span></span>
      <span className={"v-tag " + rec.verdict}><span className="vt-dot"></span>{rec.verdict}</span>
    </>
  );
  if (!hasUrl) {
    return (
      <div className="gentry disabled" title={F.shareUnavailable}>
        {inner}
      </div>
    );
  }
  return (
    <a className="gentry" href={rec.publicReportUrl} target="_blank" rel="noopener noreferrer">
      {inner}
    </a>
  );
}

function Gallery({ result, loading, onRefresh }) {
  const records = (result && result.records) || [];
  return (
    <section aria-label={F.galleryTitle}>
      <div className="section-head">
        <h2><span className="sh-hash">#</span> {F.galleryTitle}</h2>
        <span className="sh-sub">{F.gallerySub}</span>
        <span className="sh-count">
          <button className="copy-btn" onClick={onRefresh} title="Refresh gallery">
            <Icons.refresh size={12} />
          </button>
        </span>
      </div>

      {result && result.unavailable ? (
        <div className="gallery-notice err"><Icons.alert size={13} /> {F.galleryUnavailable}</div>
      ) : (
        <>
          {result && result.partial && (
            <div className="gallery-notice warn"><Icons.info size={13} /> {F.galleryPartial}</div>
          )}
          {records.length === 0 && !loading ? (
            <div className="gallery-empty">
              <div className="ge-ico"><Icons.box size={28} /></div>
              {F.galleryEmpty}
            </div>
          ) : (
            <div className="gallery-grid">
              {records.map((r, i) => <GalleryEntry key={r.packageName + "@" + r.version + i} rec={r} />)}
            </div>
          )}
        </>
      )}
    </section>
  );
}

Object.assign(window, {
  Icons, AgentHealthBanner, SearchBar, ScanProgress,
  ManualHandoffPanel, ErrorPanel, Gallery, GalleryEntry, timeAgo,
});

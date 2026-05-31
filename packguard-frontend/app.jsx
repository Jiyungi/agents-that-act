/* ============================================================
 * app.jsx — useScanFlow state machine + App shell + Tweaks
 * ============================================================ */
const { useState: uS, useEffect: uE, useRef: uR, useCallback } = React;
const FA = window.FRAMING;
const Api = window.PGApi;

/* ---------- localStorage-backed prefs ---------- */
function usePref(key, initial) {
  const [v, setV] = uS(() => {
    try { const s = localStorage.getItem("pg." + key); return s == null ? initial : JSON.parse(s); }
    catch (e) { return initial; }
  });
  uE(() => { try { localStorage.setItem("pg." + key, JSON.stringify(v)); } catch (e) {} }, [key, v]);
  return [v, setV];
}

/* =====================================================================
 * useScanFlow — explicit state machine
 * IDLE → RESOLVING → FETCHING → AWAITING_SCAN → UPLOADING → DONE | ERROR
 * ===================================================================*/
const PHASE_INDEX = { resolve: 0, fetch: 1, scan: 2, upload: 3 };

function useScanFlow(onComplete) {
  const [phase, setPhase] = uS("IDLE");
  const [target, setTarget] = uS("");
  const [contract, setContract] = uS(null);     // ScanResultContract (held across pause)
  const [result, setResult] = uS(null);         // { record, report }
  const [error, setError] = uS(null);           // { phase, errorType, message, manualCommand }
  const [log, setLog] = uS([]);
  const ctrlRef = uR(null);
  const flowTimer = uR(null);

  const now = () => new Date().toTimeString().slice(0, 8);
  const pushLog = (text, cls) => setLog((l) => l.concat([{ t: now(), text, cls }]));

  const cleanup = () => {
    if (flowTimer.current) { clearTimeout(flowTimer.current); flowTimer.current = null; }
  };

  const fail = (ph, err) => {
    cleanup();
    setError({
      phase: ph,
      errorType: err && err.errorType ? err.errorType : "ERROR",
      message: (err && err.message) || "Something went wrong.",
      manualCommand: err && err.manualCommand,
    });
    setPhase("ERROR");
  };

  const start = useCallback((name) => {
    // fresh run
    cleanup();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setError(null); setResult(null); setContract(null);
    setTarget(name); setLog([]);
    setPhase("RESOLVING");

    // §6 overall flow timeout: abort everything at 30s
    flowTimer.current = setTimeout(() => {
      ctrl.abort();
    }, Api.T_FLOW);

    pushLog("$ packguard scan " + name, "ac");
    pushLog("→ POST /api/resolve  { packageName }");

    Api.resolvePackage(name, ctrl.signal)
      .then((resolved) => {
        pushLog("resolved " + resolved.packageName + "@" + resolved.version, "ok");
        pushLog("↓ " + resolved.tarballUrl.split("/-/")[1]);
        pushLog("→ POST 127.0.0.1:3939/local/fetch");
        setPhase("FETCHING");
        return Api.fetchAndLaunch(resolved, ctrl.signal);
      })
      .then((c) => {
        pushLog("extract ./scan-target  (sandboxed — never installed)", "ok");
        pushLog("code ./scan-target  → opened in VS Code", "ac");
        setContract(c);
        setPhase("AWAITING_SCAN");
        cleanup(); // pause is durable; stop the 30s flow clock here
      })
      .catch((err) => {
        if (err && (err.name === "AbortError" || err.aborted)) {
          fail(phaseLabelFromState(), { errorType: "TIMEOUT", message: FA.flowTimeout });
        } else {
          fail(phaseLabelFromState(), err);
        }
      });

    // capture which phase we were in when aborted
    function phaseLabelFromState() {
      return ctrlRef.current === ctrl ? (contractGuess()) : "resolve";
    }
    function contractGuess() { return "resolve/fetch"; }
  }, []);

  const upload = useCallback(() => {
    if (!contract) return;
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setPhase("UPLOADING");
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
        onComplete && onComplete();
      })
      .catch((err) => {
        clearTimeout(to);
        if (err && (err.name === "AbortError" || err.aborted)) fail("upload", { errorType: "TIMEOUT", message: FA.flowTimeout });
        else fail("upload", err);
      });
  }, [contract, onComplete]);

  const reset = useCallback(() => {
    cleanup();
    if (ctrlRef.current) ctrlRef.current.abort();
    setPhase("IDLE"); setContract(null); setResult(null); setError(null); setLog([]);
  }, []);

  const cancel = reset;

  const busy = ["RESOLVING", "FETCHING", "AWAITING_SCAN", "UPLOADING"].indexOf(phase) > -1;
  const uploading = phase === "UPLOADING";
  const activeIndex = phase === "RESOLVING" ? 0 : phase === "FETCHING" ? 1
    : phase === "AWAITING_SCAN" ? 2 : phase === "UPLOADING" ? 3 : (phase === "DONE" ? 4 : 0);

  return { phase, target, contract, result, error, log, busy, uploading, activeIndex, start, upload, reset, cancel };
}

/* =====================================================================
 * Tweaks panel (terminal-styled), FAB-toggled
 * ===================================================================*/
function Segmented({ value, options, onChange }) {
  return (
    <div style={{ display: "flex", border: "1px solid var(--border-bright)", borderRadius: 4, overflow: "hidden" }}>
      {options.map((o) => (
        <button key={o.v} onClick={() => onChange(o.v)}
          style={{
            flex: 1, padding: "7px 8px", fontFamily: "var(--mono)", fontSize: 11.5, cursor: "pointer",
            border: "none", borderRight: "1px solid var(--border)",
            background: value === o.v ? "var(--accent)" : "var(--panel-2)",
            color: value === o.v ? "#fff" : "var(--text-dim)", fontWeight: value === o.v ? 700 : 400,
          }}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function TwRow({ label, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 11, color: "var(--text-faint)", marginBottom: 7, letterSpacing: 0.3 }}>{label}</div>
      {children}
    </div>
  );
}

function TweaksPanel({ open, onClose, prefs }) {
  if (!open) return null;
  const { variant, setVariant, scan, setScan, agent, setAgent, gallery, setGallery } = prefs;
  return (
    <div style={{
      position: "fixed", right: 18, bottom: 70, zIndex: 60, width: 290,
      background: "var(--panel)", border: "1px solid var(--border-bright)", borderRadius: 6,
      boxShadow: "0 18px 60px rgba(0,0,0,0.55)", padding: 16,
    }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: 0.5 }}>
          <span style={{ color: "var(--accent-bright)" }}>~/</span>tweaks
        </span>
        <button className="b-close" style={{ marginLeft: "auto", fontSize: 16 }} onClick={onClose}>×</button>
      </div>

      <TwRow label="VERDICT CARD STYLE">
        <Segmented value={variant} onChange={setVariant}
          options={[{ v: "panel", label: "Panel" }, { v: "console", label: "Console" }]} />
      </TwRow>

      <TwRow label={"SCANLINE INTENSITY · " + Math.round(scan * 100) + "%"}>
        <input type="range" min="0" max="1" step="0.05" value={scan}
          onChange={(e) => setScan(parseFloat(e.target.value))} style={{ width: "100%", accentColor: "var(--accent)" }} />
      </TwRow>

      <TwRow label="SIMULATE LOCAL AGENT">
        <Segmented value={agent} onChange={setAgent}
          options={[{ v: "ok", label: "OK" }, { v: "no-code", label: "No CLI" }, { v: "down", label: "Down" }]} />
      </TwRow>

      <TwRow label="GALLERY STATE">
        <Segmented value={gallery} onChange={setGallery}
          options={[{ v: "ok", label: "OK" }, { v: "partial", label: "Partial" }, { v: "empty", label: "Empty" }, { v: "unavailable", label: "Down" }]} />
      </TwRow>

      <div style={{ fontSize: 10.5, color: "var(--text-ghost)", lineHeight: 1.5, marginTop: 4 }}>
        Preview every contract state. Try scanning <b style={{ color: "var(--text-faint)" }}>does-not-exist-pkg</b> or <b style={{ color: "var(--text-faint)" }}>no-vscode</b> for error states.
      </div>
    </div>
  );
}

/* =====================================================================
 * App
 * ===================================================================*/
function App() {
  const [query, setQuery] = uS("");
  const [validation, setValidation] = uS("");
  const [health, setHealth] = uS(null);
  const [gallery, setGallery] = uS(null);
  const [galleryLoading, setGalleryLoading] = uS(true);
  const [twOpen, setTwOpen] = uS(false);

  // prefs
  const [variant, setVariant] = usePref("variant", "panel");
  const [scan, setScan] = usePref("scanline", 0.5);
  const [agentSim, setAgentSim] = usePref("agentSim", "ok");
  const [gallerySim, setGallerySim] = usePref("gallerySim", "ok");

  uE(() => { document.documentElement.style.setProperty("--scanline-opacity", scan); }, [scan]);
  uE(() => { window.PG_AGENT_STATE = agentSim; checkHealth(); }, [agentSim]);
  uE(() => { window.PG_GALLERY_STATE = gallerySim; refreshGallery(); }, [gallerySim]);

  const refreshGallery = useCallback(() => {
    setGalleryLoading(true);
    Api.getScans().then((g) => { setGallery(g); setGalleryLoading(false); });
  }, []);
  const checkHealth = useCallback(() => {
    setHealth({ reachable: undefined });
    Api.getHealth().then(setHealth);
  }, []);

  const flow = useScanFlow(refreshGallery);

  uE(() => { checkHealth(); /* initial */ }, []);

  const resultRef = uR(null);
  uE(() => {
    if (flow.phase === "DONE" && resultRef.current) {
      resultRef.current.focus();
    }
  }, [flow.phase]);

  const submit = () => {
    const name = query.trim();
    if (!name) { setValidation(FA.pkgRequired); return; }  // §6 reject before request
    setValidation("");
    flow.start(name);
  };

  const showProgress = ["RESOLVING", "FETCHING", "UPLOADING"].indexOf(flow.phase) > -1
    || (flow.phase === "AWAITING_SCAN");
  const errIndex = flow.phase === "ERROR"
    ? (flow.error.phase && flow.error.phase.indexOf("upload") > -1 ? 3 : (flow.activeIndex))
    : null;

  return (
    <>
      {/* topbar */}
      <div className="topbar">
        <div className="topbar-inner">
          <div className="brand-mark">
            <span className="glyph"><Icons.shield size={13} /></span>
            <b>PackGuard</b>
            <span>// inspect before you install</span>
          </div>
          <div className="topbar-spacer"></div>
          <AgentPill health={health} onClick={checkHealth} />
        </div>
      </div>

      <div className="shell">
        <AgentHealthBanner health={health} onRetry={checkHealth} />

        {/* hero */}
        <header className="hero">
          <div className="hero-kicker">{FA.resultsLabelShort}</div>
          <h1>Inspect before<br />you install<span className="pg-cursor"></span></h1>
          <p className="tagline">
            Fetch any npm package, unpack it in a sandbox <b>without installing or running it</b>,
            and get a static <b>SAFE / RISKY</b> verdict before it ever touches your project.
          </p>

          <SearchBar
            value={query}
            onChange={(v) => { setQuery(v); if (validation) setValidation(""); }}
            onSubmit={submit}
            busy={flow.busy}
            error={validation}
          />
        </header>

        {/* flow region */}
        <div aria-live="polite">
          {showProgress && (
            <ScanProgress
              target={flow.target}
              activeIndex={flow.activeIndex}
              errorIndex={null}
              logLines={flow.log}
            />
          )}

          {flow.phase === "AWAITING_SCAN" && flow.contract && (
            <ManualHandoffPanel
              contract={flow.contract}
              busy={false}
              onUpload={flow.upload}
              onCancel={flow.cancel}
            />
          )}

          {flow.phase === "ERROR" && flow.error && (
            <ErrorPanel
              phase={flow.error.phase}
              errorType={flow.error.errorType}
              message={flow.error.message}
              manualCommand={flow.error.manualCommand}
              onRetry={() => flow.start(flow.target || query.trim())}
              onDismiss={flow.reset}
            />
          )}

          {flow.phase === "DONE" && flow.result && (
            <div tabIndex={-1} ref={resultRef} style={{ outline: "none" }}>
              <VerdictCard report={flow.result.report} record={flow.result.record} variant={variant} />
              <Disclaimer />
              <div className="btn-row" style={{ marginTop: 16 }}>
                <button className="btn btn-ghost" onClick={() => { flow.reset(); setQuery(""); }}>
                  <Icons.search size={14} /> Scan another package
                </button>
              </div>
            </div>
          )}
        </div>

        {/* gallery */}
        <Gallery result={gallery} loading={galleryLoading} onRefresh={refreshGallery} />

        {/* footer */}
        <footer className="foot">
          <span className="f-attr">{FA.attribution}</span>
          <span className="f-sep">·</span>
          <span>threshold T = {window.PG_DATA.THRESHOLD}</span>
        </footer>
      </div>

      {/* tweaks */}
      <button className="tw-fab" onClick={() => setTwOpen((o) => !o)}>
        <Icons.zap size={13} /> tweaks
      </button>
      <TweaksPanel open={twOpen} onClose={() => setTwOpen(false)} prefs={{
        variant, setVariant, scan, setScan,
        agent: agentSim, setAgent: setAgentSim,
        gallery: gallerySim, setGallery: setGallerySim,
      }} />
    </>
  );
}

function AgentPill({ health, onClick }) {
  let cls = "checking", label = FA.agentChecking;
  if (health && health.reachable === false) { cls = "off"; label = "Agent offline"; }
  else if (health && health.reachable === true && !health.codeCliAvailable) { cls = "warn"; label = "Agent · no code CLI"; }
  else if (health && health.reachable === true) { cls = "ok"; label = FA.agentOk; }
  return (
    <button className={"agent-pill " + cls} onClick={onClick} title="Local agent · http://127.0.0.1:3939">
      <span className="dot"></span>{label}
    </button>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);

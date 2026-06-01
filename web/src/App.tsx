/* ============================================================
 * App.tsx — PackGuard Frontend_UI shell.
 *
 * Wires the search/scan flow (useScanFlow), the manual handoff, the verdict
 * card, the gallery, and the agent-health surfaces together. In mock mode it
 * also mounts a demo Tweaks panel to preview every contract state.
 * ============================================================ */
import { useCallback, useEffect, useRef, useState } from "react";
import type { GalleryResult } from "@shared/contracts";
import * as Api from "./api";
import type { AgentHealth } from "./api";
import { FRAMING } from "./framing";
import { THRESHOLD } from "./mock/data";
import { useScanFlow } from "./useScanFlow";
import { usePref } from "./usePref";
import { Icons } from "./components/Icons";
import { SearchBar } from "./components/SearchBar";
import { ScanProgress } from "./components/ScanProgress";
import { AgentHealthBanner, AgentPill } from "./components/AgentHealthBanner";
import { ErrorPanel } from "./components/ErrorPanel";
import { Gallery } from "./components/Gallery";
import { VerdictCard, Disclaimer } from "./components/VerdictCard";
import {
  TweaksPanel,
  type AgentSim,
  type GallerySim,
  type VariantPref,
} from "./components/TweaksPanel";

export function App() {
  const [query, setQuery] = useState("");
  const [validation, setValidation] = useState("");
  const [health, setHealth] = useState<AgentHealth | null>(null);
  const [gallery, setGallery] = useState<GalleryResult | null>(null);
  const [galleryLoading, setGalleryLoading] = useState(true);
  const [twOpen, setTwOpen] = useState(false);

  // prefs (demo)
  const [variant, setVariant] = usePref<VariantPref>("variant", "panel");
  const [scan, setScan] = usePref<number>("scanline", 0.5);
  const [agentSim, setAgentSim] = usePref<AgentSim>("agentSim", "ok");
  const [gallerySim, setGallerySim] = usePref<GallerySim>("gallerySim", "ok");

  const refreshGallery = useCallback(() => {
    setGalleryLoading(true);
    Api.getScans().then((g) => {
      setGallery(g);
      setGalleryLoading(false);
    });
  }, []);

  const checkHealth = useCallback(() => {
    setHealth({ reachable: undefined, status: "checking", codeCliAvailable: false });
    Api.getHealth().then(setHealth);
  }, []);

  const flow = useScanFlow(refreshGallery);

  // scanline intensity → CSS var
  useEffect(() => {
    document.documentElement.style.setProperty("--scanline-opacity", String(scan));
  }, [scan]);

  // mock demo overrides → re-check on change
  useEffect(() => {
    Api.mockOverrides.agent = agentSim;
    checkHealth();
  }, [agentSim, checkHealth]);

  useEffect(() => {
    Api.mockOverrides.gallery = gallerySim;
    refreshGallery();
  }, [gallerySim, refreshGallery]);

  // initial health check
  useEffect(() => {
    checkHealth();
  }, [checkHealth]);

  // focus the verdict result region on completion (a11y)
  const resultRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (flow.phase === "DONE" && resultRef.current) resultRef.current.focus();
  }, [flow.phase]);

  const submit = () => {
    const name = query.trim();
    if (!name) {
      setValidation(FRAMING.pkgRequired); // §6 reject before request
      return;
    }
    setValidation("");
    flow.start(name);
  };

  const showProgress = flow.phase === "SCANNING";

  return (
    <>
      {/* topbar */}
      <div className="topbar">
        <div className="topbar-inner">
          <div className="brand-mark">
            <span className="glyph">
              <Icons.shield size={13} />
            </span>
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
          <div className="hero-kicker">{FRAMING.resultsLabelShort}</div>
          <h1>
            Inspect before
            <br />
            you install
            <span className="pg-cursor"></span>
          </h1>
          <p className="tagline">
            Type an npm package. An agent spins up an isolated{" "}
            <b>Daytona</b> sandbox, fetches and unpacks it{" "}
            <b>without installing or running it</b>, runs an{" "}
            <b>Opsera</b> static security scan inside the sandbox, and stores a{" "}
            <b>SAFE / RISKY</b> verdict in <b>Tigris</b> — all in one click.
          </p>

          <SearchBar
            value={query}
            onChange={(v) => {
              setQuery(v);
              if (validation) setValidation("");
            }}
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
              <VerdictCard
                report={flow.result.report}
                record={flow.result.record}
                variant={variant}
              />
              <Disclaimer />
              <div className="btn-row" style={{ marginTop: 16 }}>
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    flow.reset();
                    setQuery("");
                  }}
                >
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
          <span className="f-attr">{FRAMING.attribution}</span>
          <span className="f-sep">·</span>
          <span>threshold T = {THRESHOLD}</span>
        </footer>
      </div>

      {/* tweaks — demo only (mock mode) */}
      {Api.USE_MOCK && (
        <>
          <button className="tw-fab" onClick={() => setTwOpen((o) => !o)}>
            <Icons.zap size={13} /> tweaks
          </button>
          <TweaksPanel
            open={twOpen}
            onClose={() => setTwOpen(false)}
            prefs={{
              variant,
              setVariant,
              scan,
              setScan,
              agent: agentSim,
              setAgent: setAgentSim,
              gallery: gallerySim,
              setGallery: setGallerySim,
            }}
          />
        </>
      )}
    </>
  );
}

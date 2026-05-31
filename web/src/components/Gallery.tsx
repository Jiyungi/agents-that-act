/* Gallery — browsable list of previously scanned package versions (§9). */
import type { GalleryResult, ScanRecord } from "@shared/contracts";
import { Icons } from "./Icons";
import { FRAMING } from "../framing";

export function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24);
  return d + "d ago";
}

function GalleryEntry({ rec }: { rec: ScanRecord }) {
  const hasUrl = !!rec.publicReportUrl;
  const inner = (
    <>
      <div className="ge-pkg">
        <div className="ge-name">
          {rec.packageName}
          {hasUrl && (
            <span className="ext">
              <Icons.ext size={12} />
            </span>
          )}
        </div>
        <div className="ge-ver">{rec.version}</div>
      </div>
      <span className="ge-time">{timeAgo(rec.createdAt)}</span>
      <span className="ge-score">
        risk <b>{rec.riskScore}</b>
        <span style={{ color: "var(--text-ghost)" }}>/100</span>
      </span>
      <span className={"v-tag " + rec.verdict}>
        <span className="vt-dot"></span>
        {rec.verdict}
      </span>
    </>
  );
  if (!hasUrl) {
    return (
      <div className="gentry disabled" title={FRAMING.shareUnavailable}>
        {inner}
      </div>
    );
  }
  return (
    <a className="gentry" href={rec.publicReportUrl!} target="_blank" rel="noopener noreferrer">
      {inner}
    </a>
  );
}

interface GalleryProps {
  result: GalleryResult | null;
  loading: boolean;
  onRefresh: () => void;
}

export function Gallery({ result, loading, onRefresh }: GalleryProps) {
  const records = result?.records ?? [];
  return (
    <section aria-label={FRAMING.galleryTitle}>
      <div className="section-head">
        <h2>
          <span className="sh-hash">#</span> {FRAMING.galleryTitle}
        </h2>
        <span className="sh-sub">{FRAMING.gallerySub}</span>
        <span className="sh-count">
          <button className="copy-btn" onClick={onRefresh} title="Refresh gallery">
            <Icons.refresh size={12} />
          </button>
        </span>
      </div>

      {result && result.unavailable ? (
        <div className="gallery-notice err">
          <Icons.alert size={13} /> {FRAMING.galleryUnavailable}
        </div>
      ) : (
        <>
          {result && result.partial && (
            <div className="gallery-notice warn">
              <Icons.info size={13} /> {FRAMING.galleryPartial}
            </div>
          )}
          {records.length === 0 && !loading ? (
            <div className="gallery-empty">
              <div className="ge-ico">
                <Icons.box size={28} />
              </div>
              {FRAMING.galleryEmpty}
            </div>
          ) : (
            <div className="gallery-grid">
              {records.map((r, i) => (
                <GalleryEntry key={r.packageName + "@" + r.version + i} rec={r} />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

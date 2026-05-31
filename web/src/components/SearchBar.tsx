/* SearchBar — package-name input + Scan control (§6). */
import { useRef } from "react";
import { Icons } from "./Icons";

interface SearchBarProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  busy: boolean;
  error: string;
}

const EXAMPLES = ["event-stream", "chalk", "left-pad", "colors", "lodash"];

export function SearchBar({ value, onChange, onSubmit, busy, error }: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="search-wrap">
      <form
        className="search-box-form"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <div className={"search-box" + (error ? " invalid" : "")}>
          <span className="search-prompt" aria-hidden="true">
            $
          </span>
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
          />
          <button className="scan-btn" type="submit" disabled={busy} aria-busy={busy}>
            {busy ? (
              <>
                <span className="spin">
                  <Icons.refresh size={13} />
                </span>{" "}
                SCANNING
              </>
            ) : (
              <>
                <Icons.search size={14} /> SCAN
              </>
            )}
          </button>
        </div>
      </form>
      <div
        id="search-msg"
        className={"search-msg" + (error ? " err" : "")}
        role={error ? "alert" : undefined}
        aria-live="assertive"
      >
        {error || ""}
      </div>
      <div className="search-hint">
        <b>try:</b>{" "}
        {EXAMPLES.map((ex) => (
          <span
            key={ex}
            className="chip"
            onClick={() => {
              onChange(ex);
              inputRef.current?.focus();
            }}
          >
            {ex}
          </span>
        ))}
      </div>
    </div>
  );
}

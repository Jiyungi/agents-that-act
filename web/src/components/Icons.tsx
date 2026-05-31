/* ============================================================
 * Icons.tsx — inline, stroke-based icon set (no icon-lib dependency).
 * ============================================================ */
import type { CSSProperties, ReactNode } from "react";

interface IcoProps {
  d?: string;
  size?: number;
  fill?: string;
  vb?: number;
  sw?: number;
  children?: ReactNode;
  style?: CSSProperties;
}

function Ico({ d, size = 16, fill = "none", vb = 24, sw = 1.75, children, style }: IcoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${vb} ${vb}`}
      fill={fill}
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
    >
      {d ? <path d={d} /> : children}
    </svg>
  );
}

type IcoP = Omit<IcoProps, "d" | "children">;

export const Icons = {
  shield: (p: IcoP) => <Ico {...p} d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />,
  check: (p: IcoP) => <Ico {...p} d="M20 6L9 17l-5-5" />,
  alert: (p: IcoP) => (
    <Ico {...p}>
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
      <path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" />
    </Ico>
  ),
  search: (p: IcoP) => (
    <Ico {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </Ico>
  ),
  chevron: (p: IcoP) => <Ico {...p} d="M9 6l6 6-6 6" />,
  arrow: (p: IcoP) => <Ico {...p} d="M5 12h14M13 6l6 6-6 6" />,
  ext: (p: IcoP) => (
    <Ico {...p}>
      <path d="M15 3h6v6" />
      <path d="M10 14L21 3" />
      <path d="M21 14v5a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h5" />
    </Ico>
  ),
  copy: (p: IcoP) => (
    <Ico {...p}>
      <rect x="9" y="9" width="11" height="11" rx="1.5" />
      <path d="M5 15V5a2 2 0 012-2h10" />
    </Ico>
  ),
  info: (p: IcoP) => (
    <Ico {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </Ico>
  ),
  box: (p: IcoP) => (
    <Ico {...p}>
      <path d="M21 8l-9-5-9 5 9 5 9-5z" />
      <path d="M3 8v8l9 5 9-5V8" />
      <path d="M12 13v8" />
    </Ico>
  ),
  code: (p: IcoP) => <Ico {...p} d="M8 6l-6 6 6 6M16 6l6 6-6 6" />,
  upload: (p: IcoP) => (
    <Ico {...p}>
      <path d="M12 16V4M6 10l6-6 6 6" />
      <path d="M4 20h16" />
    </Ico>
  ),
  zap: (p: IcoP) => <Ico {...p} d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />,
  refresh: (p: IcoP) => (
    <Ico {...p}>
      <path d="M21 12a9 9 0 11-3-6.7L21 8" />
      <path d="M21 3v5h-5" />
    </Ico>
  ),
};

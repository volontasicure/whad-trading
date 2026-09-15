import type { DataStatus } from "../types";

const LABEL: Record<DataStatus, string> = {
  loading: "CARICAMENTO",
  live: "REALE",
  mock: "SIMULATO",
  offline: "OFFLINE",
};

const COLORS: Record<DataStatus, { bg: string; fg: string }> = {
  loading: { bg: "var(--fill-neutral)", fg: "var(--text-faint)" },
  live: { bg: "var(--green-tint)", fg: "var(--green-ink)" },
  mock: { bg: "var(--fill-neutral)", fg: "var(--text-faint)" },
  offline: { bg: "var(--red-tint)", fg: "var(--red-ink)" },
};

/** Badge discreto di stato dati (REALE/SIMULATO/CARICAMENTO/OFFLINE), riusato in ogni pannello con dati reali con fallback. */
export function StatusBadge({ status, title }: { status: DataStatus; title?: string }) {
  const { bg, fg } = COLORS[status];
  return (
    <div
      className="mono"
      title={title}
      style={{
        fontSize: 8.5,
        letterSpacing: "0.08em",
        padding: "2px 5px",
        borderRadius: 4,
        whiteSpace: "nowrap",
        background: bg,
        color: fg,
      }}
    >
      {LABEL[status]}
    </div>
  );
}

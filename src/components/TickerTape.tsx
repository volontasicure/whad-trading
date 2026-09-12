import { MARKET, dec, pnlColor } from "../data/mockData";

const TAPE_ITEMS = [...MARKET, ...MARKET];

export function TickerTape() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        overflow: "hidden",
        borderTop: "1px solid var(--border-main)",
        borderBottom: "1px solid var(--border-main)",
        background: "var(--bg-surface)",
        height: 38,
        flex: "0 0 auto",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "0 14px",
          height: "100%",
          borderRight: "1px solid var(--border-divider)",
          flex: "0 0 auto",
        }}
      >
        <div className="dot dot-live" />
        <div className="mono" style={{ fontSize: 9.5, letterSpacing: "0.12em", color: "var(--text-faint)" }}>
          LIVE
        </div>
      </div>
      <div style={{ overflow: "hidden", flex: "1 1 auto", minWidth: 0, height: "100%", display: "flex", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", width: "max-content", animation: "tapeScroll 42s linear infinite" }}>
          {TAPE_ITEMS.map((t, i) => (
            <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 7, flex: "0 0 auto", padding: "0 14px" }}>
              <div className="mono" style={{ fontSize: 11.5, fontWeight: 500 }}>
                {t.symbol}
              </div>
              <div className="mono" style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                {dec(t.price, 2)}
              </div>
              <div className="mono" style={{ fontSize: 11, color: pnlColor(t.changePct) }}>
                {(t.changePct > 0 ? "+" : "−") + dec(Math.abs(t.changePct), 2) + "%"}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

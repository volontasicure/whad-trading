import { NavLink } from "react-router-dom";
import { useAppState } from "../context/AppState";
import { BROKERS } from "../data/mockData";

const NAV_ITEMS = [
  { to: "/lab", label: "Laboratorio" },
  { to: "/strategie", label: "Strategie" },
  { to: "/debriefing", label: "Debriefing" },
  { to: "/reale", label: "Portafoglio reale" },
  { to: "/storico", label: "Storico" },
  { to: "/regole", label: "Regole" },
];

function useCountdown(now: Date): string {
  const close = new Date(now);
  close.setHours(22, 0, 0, 0);
  const d = Math.max(0, Math.floor((close.getTime() - now.getTime()) / 1000));
  const parts = [Math.floor(d / 3600), Math.floor((d % 3600) / 60), d % 60];
  return parts.map((x) => String(x).padStart(2, "0")).join(":");
}

export function Sidebar() {
  const { now } = useAppState();
  const countdown = useCountdown(now);
  const alpaca = BROKERS.find((b) => b.id === "alpaca")!;
  const ibkr = BROKERS.find((b) => b.id === "ibkr")!;

  return (
    <div
      style={{
        width: 228,
        flex: "0 0 228px",
        background: "var(--bg-surface)",
        borderRight: "1px solid var(--border-main)",
        display: "flex",
        flexDirection: "column",
        padding: "24px 0 18px",
      }}
    >
      <div style={{ padding: "0 20px 24px", display: "flex", flexDirection: "column", gap: 4 }}>
        <div className="mono" style={{ fontSize: 14, fontWeight: 600, letterSpacing: "0.14em" }}>
          WHAD<span style={{ color: "var(--accent)" }}>·</span>TRADING
        </div>
        <div className="mono" style={{ fontSize: 10, letterSpacing: "0.1em", color: "var(--text-faint)" }}>
          STRATEGY LAB
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "0 10px" }}>
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) => `sidebar-nav-item${isActive ? " active" : ""}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "9px 11px",
              borderRadius: 7,
              cursor: "pointer",
            }}
          >
            <div className="dot sidebar-nav-dot" />
            <div style={{ fontSize: 13, fontWeight: 500, letterSpacing: "0.01em" }}>{item.label}</div>
          </NavLink>
        ))}
      </div>

      <div style={{ flex: "1 1 auto", minHeight: 24 }} />

      <div style={{ padding: "0 16px", display: "flex", flexDirection: "column", gap: 10 }}>
        <div
          style={{
            border: "1px solid var(--border-main)",
            borderRadius: 9,
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 9,
          }}
        >
          <div className="mono" style={{ fontSize: 9.5, letterSpacing: "0.12em", color: "var(--text-faint)" }}>
            BROKER
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <div style={{ fontSize: 12.5, fontWeight: 500 }}>{alpaca.displayName}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div className="dot dot-live" />
              <div className="mono" style={{ fontSize: 10, color: "var(--green-ink)" }}>
                LIVE
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <div style={{ fontSize: 12.5, color: "var(--text-faint)" }}>{ibkr.displayName === "Interactive Brokers" ? "IBKR" : ibkr.displayName}</div>
            <div className="mono" style={{ fontSize: 10, color: "var(--text-disabled)" }}>
              OFF
            </div>
          </div>
        </div>

        <div
          style={{
            border: "1px solid var(--border-main)",
            borderRadius: 9,
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 5,
          }}
        >
          <div className="mono" style={{ fontSize: 9.5, letterSpacing: "0.12em", color: "var(--text-faint)" }}>
            CHIUSURA MERCATO
          </div>
          <div className="mono" style={{ fontSize: 19, fontWeight: 500 }}>
            {countdown}
          </div>
        </div>
      </div>
    </div>
  );
}

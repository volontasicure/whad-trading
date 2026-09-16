import { CAPITAL, MARKET } from "../data/mockData";

interface HeaderProps {
  kicker: string;
  title: string;
}

export function Header({ kicker, title }: HeaderProps) {
  const seduta = new Date().toLocaleDateString("it-IT", { day: "2-digit", month: "short", year: "numeric" });
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "space-between",
        gap: 20,
        flexWrap: "wrap",
        padding: "26px 30px 18px",
        background: "var(--bg-subtle)",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0 }}>
        <div className="view-kicker">{kicker}</div>
        <div className="view-title">{title}</div>
      </div>
      <div style={{ display: "flex", alignItems: "stretch", gap: 22, flexWrap: "wrap" }}>
        <HeaderStat label="SEDUTA" value={seduta} />
        <HeaderStat label="CAPITALE / PORTAF." value={`${CAPITAL.toLocaleString("it-IT")} $`} />
        <HeaderStat label="UNIVERSO" value={`${MARKET.length} titoli · ${(100 / MARKET.length).toFixed(1)}% cad.`} />
      </div>
    </div>
  );
}

function HeaderStat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div className="mono" style={{ fontSize: 9.5, letterSpacing: "0.12em", color: "var(--text-faint)", whiteSpace: "nowrap" }}>
        {label}
      </div>
      <div className="mono" style={{ fontSize: 13, whiteSpace: "nowrap" }}>
        {value}
      </div>
    </div>
  );
}

import { Header } from "../components/Header";
import { TickerTape } from "../components/TickerTape";
import { SESSIONS, STRATEGIES, STRATEGY_HISTORY_STATS, dec, money, pnlColor } from "../data/mockData";

export function HistoryView() {
  return (
    <>
      <Header kicker="ARCHIVIO" title="Storico e analytics" />
      <TickerTape />
      <div style={{ padding: "22px 30px 40px", display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 14 }}>
          {STRATEGY_HISTORY_STATS.map((s) => (
            <div key={s.strategyId} className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ fontSize: 14, fontWeight: 500, lineHeight: 1.25, minHeight: 36 }}>{s.name}</div>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <div className="mono" style={{ fontSize: 9, letterSpacing: "0.08em", color: "var(--text-faint)" }}>P&amp;L 20 SEDUTE</div>
                  <div className="mono" style={{ fontSize: 21, fontWeight: 500, whiteSpace: "nowrap", color: pnlColor(s.netOver10Sessions) }}>
                    {money(s.netOver10Sessions)}
                  </div>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(64px, 1fr))", gap: 10, borderTop: "1px solid var(--border-divider)", paddingTop: 12 }}>
                <MiniStat k="SCELTA" v={`${s.timesPicked} / 10`} />
                <MiniStat k="SHARPE" v={dec(s.sharpe, 2)} />
                <MiniStat k="COSTI" v={`−${s.costs}`} />
              </div>
            </div>
          ))}
        </div>

        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ padding: "15px 18px", borderBottom: "1px solid var(--border-divider)", display: "flex", flexDirection: "column", gap: 3 }}>
            <div style={{ fontSize: 15, fontWeight: 500 }}>Storico sedute</div>
            <div style={{ fontSize: 11.5, color: "var(--text-secondary-2)" }}>
              Strategia scelta ogni mattina e risultato reale, confrontato con il portafoglio laboratorio corrispondente.
            </div>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(66px, 0.8fr) minmax(0, 2fr) minmax(0, 0.9fr) minmax(0, 0.9fr) minmax(0, 0.8fr) minmax(0, 0.9fr)",
              alignItems: "center",
              padding: "0 18px",
              height: 34,
              background: "var(--bg-subtle)",
              borderBottom: "1px solid var(--border-divider)",
            }}
          >
            <div className="table-header-cell">DATA</div>
            <div className="table-header-cell">STRATEGIA</div>
            <div className="table-header-cell" style={{ textAlign: "right" }}>NETTO</div>
            <div className="table-header-cell" style={{ textAlign: "right" }}>SCOST.</div>
            <div className="table-header-cell" style={{ textAlign: "right" }}>OP.</div>
            <div className="table-header-cell" style={{ textAlign: "right" }}>COSTI</div>
          </div>
          {SESSIONS.map((h, i) => {
            const strat = STRATEGIES.find((s) => s.id === h.strategyId)!;
            return (
              <div
                key={i}
                className="row-hover"
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(66px, 0.8fr) minmax(0, 2fr) minmax(0, 0.9fr) minmax(0, 0.9fr) minmax(0, 0.8fr) minmax(0, 0.9fr)",
                  alignItems: "center",
                  padding: "0 18px",
                  height: 44,
                  borderBottom: "1px solid var(--border-subtle)",
                }}
              >
                <div className="mono" style={{ fontSize: 11.5, color: "var(--text-secondary)", whiteSpace: "nowrap" }}>{h.date}</div>
                <div style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: 10 }}>{strat.name}</div>
                <div className="mono" style={{ fontSize: 12.5, textAlign: "right", color: pnlColor(h.net) }}>{money(h.net)}</div>
                <div className="mono" style={{ fontSize: 11.5, textAlign: "right", color: "var(--text-secondary-2)" }}>
                  {(h.deviationPct > 0 ? "+" : "−") + dec(Math.abs(h.deviationPct), 1)}%
                </div>
                <div className="mono" style={{ fontSize: 11.5, textAlign: "right", color: "var(--text-secondary-2)" }}>{h.trades}</div>
                <div className="mono" style={{ fontSize: 11.5, textAlign: "right", color: "var(--text-secondary-2)" }}>{"−" + h.costs}</div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function MiniStat({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <div className="mono" style={{ fontSize: 9, color: "var(--text-faint)", whiteSpace: "nowrap" }}>{k}</div>
      <div className="mono" style={{ fontSize: 13, whiteSpace: "nowrap" }}>{v}</div>
    </div>
  );
}

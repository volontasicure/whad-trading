import { useNavigate } from "react-router-dom";
import { Header } from "../components/Header";
import { TickerTape } from "../components/TickerTape";
import { useAppState } from "../context/AppState";
import { BACKTEST_ORDER, BEST_STRATEGY_INDEX, DEBRIEF, STRATEGIES, dec, money } from "../data/mockData";

export function DebriefView() {
  const navigate = useNavigate();
  const { confirmed, autoConfirm, confirmChoice } = useAppState();

  const best = STRATEGIES[BEST_STRATEGY_INDEX];
  const isConfirmed = confirmed || autoConfirm;

  return (
    <>
      <Header kicker="PRE-APERTURA" title="Debriefing del mattino" />
      <TickerTape />
      <div style={{ padding: "22px 30px 40px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))", gap: 18, alignItems: "start" }}>
        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ padding: "16px 18px", borderBottom: "1px solid var(--border-divider)", display: "flex", flexDirection: "column", gap: 3 }}>
            <div style={{ fontSize: 15, fontWeight: 500 }}>Classifica del debriefing</div>
            <div style={{ fontSize: 11.5, color: "var(--text-secondary-2)" }}>
              Punteggio su 20 sedute: P&amp;L netto al netto dei costi, Sharpe, % vincenti e coerenza con il regime di
              volatilità atteso.
            </div>
          </div>
          {BACKTEST_ORDER.map((o, k) => {
            const s = STRATEGIES[o.i];
            const entry = DEBRIEF.ranking[k];
            const barW = (entry.score / 20) * 100;
            return (
              <div key={s.id} style={{ padding: "16px 18px", borderBottom: "1px solid var(--border-subtle)", display: "flex", flexDirection: "column", gap: 11 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <div className="mono" style={{ fontSize: 12, color: "var(--text-faint)" }}>{"0" + (k + 1)}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: "1 1 180px" }}>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{s.name}</div>
                    <div style={{ fontSize: 11.5, color: "var(--text-secondary-2)" }}>{s.note}</div>
                  </div>
                  <div
                    className="badge"
                    style={{
                      background: k === 0 ? "var(--green-tint)" : "var(--fill-neutral)",
                      color: k === 0 ? "var(--green-ink)" : "var(--text-faint)",
                    }}
                  >
                    {k === 0 ? "PROPOSTA" : "IN ATTESA"}
                  </div>
                  <div className="mono" style={{ fontSize: 18, fontWeight: 500, textAlign: "right" }}>
                    {dec(entry.score, 1)}
                  </div>
                </div>
                <div style={{ height: 6, borderRadius: 4, background: "#f0f0ec", overflow: "hidden" }}>
                  <div style={{ height: 6, borderRadius: 4, width: `${barW}%`, background: k === 0 ? "var(--accent)" : "#dcdbd5" }} />
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div className="card" style={{ borderColor: "var(--green-border)", padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="mono" style={{ fontSize: 10, letterSpacing: "0.13em", color: "var(--green-ink)" }}>
              PROPOSTA PER OGGI
            </div>
            <div style={{ fontSize: 21, fontWeight: 500, letterSpacing: "-0.015em" }}>{best.name}</div>
            <div style={{ fontSize: 12.5, color: "var(--text-secondary-2)", lineHeight: 1.5 }}>
              {best.note} Netto più alto sulle ultime 20 sedute: {money(BACKTEST_ORDER[0].net)} $ dopo i costi, Sharpe{" "}
              {dec(best.backtest.sharpe, 2)}.
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
                gap: 12,
                borderTop: "1px solid var(--border-divider)",
                paddingTop: 14,
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <div className="mono" style={{ fontSize: 9, letterSpacing: "0.08em", color: "var(--text-faint)" }}>CONFIDENZA</div>
                <div className="mono" style={{ fontSize: 15 }}>{DEBRIEF.confidence}%</div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <div className="mono" style={{ fontSize: 9, letterSpacing: "0.08em", color: "var(--text-faint)" }}>REGIME VIX</div>
                <div className="mono" style={{ fontSize: 15 }}>
                  {dec(DEBRIEF.vix.value, 1)} · {DEBRIEF.vix.regime}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
              <div
                className={`btn-primary${isConfirmed ? " confirmed" : ""}`}
                style={{ flex: "1 1 160px" }}
                onClick={() => {
                  confirmChoice();
                  navigate("/reale");
                }}
              >
                {isConfirmed ? "Attiva sul conto reale ✓" : "Conferma e attiva"}
              </div>
              <div className="btn-secondary" style={{ flex: "0 1 auto", padding: "11px 14px" }} onClick={() => navigate(`/strategie/${best.id}`)}>
                Scegli un'altra
              </div>
            </div>
          </div>

          <div className="card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="mono" style={{ fontSize: 10, letterSpacing: "0.13em", color: "var(--text-faint)" }}>
              CHECKLIST PRE-APERTURA
            </div>
            {DEBRIEF.checklist.map((c, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div
                  className="mono"
                  style={{
                    width: 16,
                    height: 16,
                    flex: "0 0 auto",
                    borderRadius: 5,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 10,
                    background: c.status === "ok" ? "var(--green-tint)" : "var(--amber-tint)",
                    color: c.status === "ok" ? "var(--green-ink)" : "var(--amber-ink)",
                  }}
                >
                  {c.status === "ok" ? "✓" : "!"}
                </div>
                <div style={{ fontSize: 12.5, flex: "1 1 auto", minWidth: 0 }}>{c.label}</div>
                <div className="mono" style={{ fontSize: 11, color: "var(--text-faint)", whiteSpace: "nowrap" }}>{c.value}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

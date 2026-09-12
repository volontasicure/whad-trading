import { Navigate, useNavigate, useParams } from "react-router-dom";
import { Header } from "../components/Header";
import { PnlHistogram } from "../components/PnlHistogram";
import { TickerTape } from "../components/TickerTape";
import { STRATEGIES, dec, money, pnlColor } from "../data/mockData";

export function StrategyView() {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();

  if (!id) return <Navigate to={`/strategie/${STRATEGIES[0].id}`} replace />;
  const sel = STRATEGIES.find((s) => s.id === id);
  if (!sel) return <Navigate to={`/strategie/${STRATEGIES[0].id}`} replace />;

  return (
    <>
      <Header kicker="PARAMETRI E BACKTEST" title="Messa a punto della strategia" />
      <TickerTape />
      <div style={{ padding: "22px 30px 40px", display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {STRATEGIES.map((s) => (
            <div
              key={s.id}
              className={`tab${s.id === sel.id ? " active" : ""}`}
              onClick={() => navigate(`/strategie/${s.id}`)}
            >
              {s.code} · {s.shortName}
            </div>
          ))}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 18, alignItems: "start" }}>
          <div className="card" style={{ overflow: "hidden" }}>
            <div style={{ padding: "16px 18px", borderBottom: "1px solid var(--border-divider)", display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ fontSize: 16, fontWeight: 500 }}>{sel.name}</div>
              <div style={{ fontSize: 11.5, color: "var(--text-secondary-2)" }}>{sel.logic}</div>
            </div>
            <div style={{ padding: "6px 18px 14px" }}>
              <div className="mono" style={{ fontSize: 9.5, letterSpacing: "0.12em", color: "var(--text-faint)", padding: "12px 0 4px" }}>
                PARAMETRI
              </div>
              {sel.params.map((p, i) => (
                <div
                  key={i}
                  style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderTop: "1px solid var(--border-subtle)" }}
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: "1 1 auto", minWidth: 0 }}>
                    <div style={{ fontSize: 12.5 }}>{p.label}</div>
                    <div style={{ fontSize: 11, color: "var(--text-faint)" }}>{p.hint}</div>
                  </div>
                  <div
                    className="mono"
                    style={{ fontSize: 12.5, padding: "5px 10px", borderRadius: 6, background: "var(--fill-neutral)", whiteSpace: "nowrap" }}
                  >
                    {p.value}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <div className="card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div style={{ fontSize: 15, fontWeight: 500 }}>Backtest</div>
                <div className="mono" style={{ fontSize: 10, letterSpacing: "0.1em", color: "var(--text-faint)", whiteSpace: "nowrap" }}>
                  ULTIME 20 SEDUTE · STESSO UNIVERSO
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(84px, 1fr))", gap: "14px 10px" }}>
                <BacktestMetric k="NETTO" v={money(sel.backtest.net)} color={pnlColor(sel.backtest.net)} />
                <BacktestMetric k="SHARPE" v={dec(sel.backtest.sharpe, 2)} />
                <BacktestMetric k="WIN %" v={`${Math.round(sel.backtest.winRate * 100)}%`} />
                <BacktestMetric k="OP. / SEDUTA" v={String(sel.backtest.tradesPerSession)} />
                <BacktestMetric k="COSTI" v={`−${sel.backtest.costs}`} color="var(--red-ink)" />
                <BacktestMetric k="PROFIT FACTOR" v={dec(sel.backtest.profitFactor, 2)} />
              </div>
            </div>

            <div className="card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ fontSize: 15, fontWeight: 500 }}>P&amp;L per seduta</div>
              <PnlHistogram values={sel.backtest.dailyPnl} />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function BacktestMetric({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div className="mono" style={{ fontSize: 9, letterSpacing: "0.08em", color: "var(--text-faint)", whiteSpace: "nowrap" }}>
        {k}
      </div>
      <div className="mono" style={{ fontSize: 17, whiteSpace: "nowrap", color: color ?? "var(--text-primary)" }}>
        {v}
      </div>
    </div>
  );
}

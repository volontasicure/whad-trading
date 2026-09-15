import { Header } from "../components/Header";
import { PnlModeToggle } from "../components/PnlModeToggle";
import { StatusBadge } from "../components/StatusBadge";
import { TickerTape } from "../components/TickerTape";
import { useAppState } from "../context/AppState";
import { useRealPortfolio } from "../hooks/useRealPortfolio";
import {
  BEST_STRATEGY_INDEX,
  CAPITAL,
  STRATEGIES,
  dec,
  formatPnl,
  money,
  pnlColor,
  periodPnlFor,
} from "../data/mockData";

export function LiveView() {
  const { pnlMode, eodAutoClose, confirmedAt, liveMarket } = useAppState();
  const { data: real, source: realSource } = useRealPortfolio();
  const best = STRATEGIES[BEST_STRATEGY_INDEX];
  const labPnl = periodPnlFor(best.code.toLowerCase().replace(" ", "-"));
  const openPositions = real.positions.slice(0, 8);
  const labToday = liveMarket.strategySums[BEST_STRATEGY_INDEX];
  const labTodayNet = labToday.unrealized + labToday.realized;
  const deviationPct = ((real.realizedToday - labTodayNet) / CAPITAL) * 100;

  return (
    <>
      <Header kicker="AMBIENTE REALE" title="Esecuzione della giornata" />
      <TickerTape />
      <div style={{ padding: "22px 30px 40px", display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
          <div className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 9 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div className="dot dot-live" />
              <div className="mono" style={{ fontSize: 10, letterSpacing: "0.13em", color: "var(--green-ink)" }}>
                IN ESECUZIONE
              </div>
              <StatusBadge
                status={realSource === "loading" ? "loading" : realSource === "live" ? "live" : "offline"}
                title={
                  realSource === "offline"
                    ? "Conto Alpaca non raggiungibile: dati segnaposto"
                    : realSource === "loading"
                      ? "Prima lettura del conto reale in corso"
                      : "Dati correnti dal conto Alpaca"
                }
              />
            </div>
            <div style={{ fontSize: 18, fontWeight: 500, letterSpacing: "-0.015em", lineHeight: 1.25 }}>{best.name}</div>
            <div style={{ fontSize: 11.5, color: "var(--text-secondary-2)" }}>
              Confermata alle {confirmedAt ?? "15:31"} · Alpaca · conto reale
            </div>
          </div>
          <Kpi label="REALIZED OGGI" value={money(real.realizedToday)} color={pnlColor(real.realizedToday)} sub={`${real.executions.length} esecuzioni oggi`} />
          <Kpi
            label="UNREALIZED"
            value={money(real.unrealized)}
            color={pnlColor(real.unrealized)}
            sub={`${openPositions.length} posizioni aperte`}
          />
          <Kpi
            label="SCOSTAMENTO DA LAB"
            value={`${dec(deviationPct, 1).replace("-", "−")}%`}
            color="var(--text-secondary)"
            sub={`lab ${best.code}: ${money(labTodayNet)} $ oggi`}
          />
        </div>

        <div className="card" style={{ overflow: "hidden" }}>
          <div
            style={{
              padding: "15px 18px",
              borderBottom: "1px solid var(--border-divider)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 3, flex: "1 1 200px", minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 500 }}>P&amp;L realized del conto reale</div>
              <div className="mono" style={{ fontSize: 10, letterSpacing: "0.1em", color: "var(--text-faint)" }}>
                {pnlMode === "abs" ? "VALORI IN $" : "% SU 100.000 $ DI CAPITALE"}
              </div>
            </div>
            <PnlModeToggle />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
            <PeriodCell label="ULTIMA GIORNATA" value={real.periodPnl.lastSession} sub="seduta odierna" pnlMode={pnlMode} />
            <PeriodCell label="SETTIMANA PREC." value={real.periodPnl.previousWeek} sub="ultimi 7 giorni" pnlMode={pnlMode} />
            <PeriodCell label="MESE PREC." value={real.periodPnl.previousMonth} sub="ultimi 30 giorni" pnlMode={pnlMode} />
            <PeriodCell label="DA INIZIO" value={real.periodPnl.sinceInception} sub={`dal ${real.periodPnl.inceptionDate}`} pnlMode={pnlMode} />
          </div>

          <div style={{ borderTop: "1px solid var(--border-divider)", background: "var(--bg-subtle)" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "11px 18px 0", minWidth: 0 }}>
              <div className="mono" style={{ fontSize: 10, letterSpacing: "0.11em", color: "var(--text-faint)", whiteSpace: "nowrap" }}>
                STESSO PERIODO NEL LAB
              </div>
              <div style={{ fontSize: 11.5, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {best.shortName}
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
              {[labPnl.lastSession, labPnl.previousWeek, labPnl.previousMonth, labPnl.sinceInception].map((v, i) => (
                <div key={i} className="mono" style={{ padding: "6px 18px 12px", fontSize: 12.5, color: pnlColor(v) }}>
                  {formatPnl(v, pnlMode)}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(430px, 1fr))", gap: 18, alignItems: "start" }}>
          <div className="card" style={{ overflow: "hidden" }}>
            <div
              style={{
                padding: "15px 18px",
                borderBottom: "1px solid var(--border-divider)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <div style={{ fontSize: 15, fontWeight: 500, whiteSpace: "nowrap" }}>Posizioni aperte</div>
              <div className="mono" style={{ fontSize: 10, letterSpacing: "0.1em", color: "var(--text-faint)", whiteSpace: "nowrap" }}>
                CHIUSURA AUTO. SE UNREAL. &gt; 0
              </div>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(60px, 0.8fr) minmax(0, 1.15fr) minmax(0, 0.8fr) minmax(0, 0.8fr) minmax(0, 0.9fr) minmax(74px, 1fr)",
                alignItems: "center",
                padding: "0 18px",
                height: 34,
                background: "var(--bg-subtle)",
                borderBottom: "1px solid var(--border-divider)",
              }}
            >
              <div className="table-header-cell">TITOLO</div>
              <div className="table-header-cell">POSIZIONE</div>
              <div className="table-header-cell" style={{ textAlign: "right" }}>MEDIO</div>
              <div className="table-header-cell" style={{ textAlign: "right" }}>ULTIMO</div>
              <div className="table-header-cell" style={{ textAlign: "right" }}>UNREAL.</div>
              <div className="table-header-cell" style={{ textAlign: "right" }}>EOD</div>
            </div>
            {openPositions.map((p) => {
              const closeEod = p.unrealized > 0 && eodAutoClose;
              return (
                <div
                  key={p.symbol}
                  className="row-hover"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(60px, 0.8fr) minmax(0, 1.15fr) minmax(0, 0.8fr) minmax(0, 0.8fr) minmax(0, 0.9fr) minmax(74px, 1fr)",
                    alignItems: "center",
                    padding: "0 18px",
                    height: 44,
                    borderBottom: "1px solid var(--border-subtle)",
                  }}
                >
                  <div className="mono" style={{ fontSize: 12.5, fontWeight: 500 }}>{p.symbol}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className={`chip ${p.side === "LONG" ? "chip-long" : p.side === "SHORT" ? "chip-short" : "chip-flat"}`}>{p.side}</span>
                    <div className="mono" style={{ fontSize: 11.5, color: "var(--text-secondary-2)", whiteSpace: "nowrap" }}>{p.qty} pz</div>
                  </div>
                  <div className="mono" style={{ fontSize: 11.5, textAlign: "right", color: "var(--text-secondary-2)" }}>{dec(p.avgPrice, 2)}</div>
                  <div className="mono" style={{ fontSize: 11.5, textAlign: "right" }}>{dec(p.lastPrice, 2)}</div>
                  <div className="mono" style={{ fontSize: 12.5, textAlign: "right", color: pnlColor(p.unrealized) }}>{money(p.unrealized)}</div>
                  <div
                    className="mono"
                    style={{
                      fontSize: 10,
                      justifySelf: "end",
                      padding: "4px 7px",
                      borderRadius: 5,
                      whiteSpace: "nowrap",
                      background: closeEod ? "var(--green-tint)" : "var(--fill-neutral)",
                      color: closeEod ? "var(--green-ink)" : "var(--text-faint)",
                    }}
                  >
                    {closeEod ? "CHIUDI EOD" : "MANTIENI"}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="card" style={{ overflow: "hidden" }}>
            <div style={{ padding: "15px 18px", borderBottom: "1px solid var(--border-divider)", display: "flex", alignItems: "center", gap: 9 }}>
              <div style={{ fontSize: 15, fontWeight: 500 }}>Esecuzioni</div>
              <div className="dot dot-live" />
            </div>
            {real.executions.map((f, i) => (
              <div key={i} style={{ padding: "11px 18px", borderBottom: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", gap: 10 }}>
                <div className="mono" style={{ fontSize: 11, color: "var(--text-faint)", whiteSpace: "nowrap" }}>{f.ts}</div>
                <span className={`chip ${f.action === "BUY" ? "chip-long" : "chip-short"}`}>{f.action}</span>
                <div className="mono" style={{ fontSize: 12, fontWeight: 500 }}>{f.symbol}</div>
                <div style={{ flex: "1 1 auto", minWidth: 4 }} />
                <div className="mono" style={{ fontSize: 11.5, whiteSpace: "nowrap", color: f.realized == null ? "var(--text-secondary)" : pnlColor(f.realized) }}>
                  {f.realized == null ? "—" : money(f.realized)}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function Kpi({ label, value, color, sub }: { label: string; value: string; color: string; sub: string }) {
  return (
    <div className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 7 }}>
      <div className="mono" style={{ fontSize: 9.5, letterSpacing: "0.11em", color: "var(--text-faint)", whiteSpace: "nowrap" }}>
        {label}
      </div>
      <div className="mono" style={{ fontSize: 24, fontWeight: 500, letterSpacing: "-0.02em", whiteSpace: "nowrap", color }}>
        {value}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-faint)" }}>{sub}</div>
    </div>
  );
}

function PeriodCell({ label, value, sub, pnlMode }: { label: string; value: number; sub: string; pnlMode: "abs" | "pct" }) {
  return (
    <div style={{ padding: "16px 18px", borderRight: "1px solid var(--border-subtle)", display: "flex", flexDirection: "column", gap: 6 }}>
      <div className="mono" style={{ fontSize: 9.5, letterSpacing: "0.11em", color: "var(--text-faint)", whiteSpace: "nowrap" }}>
        {label}
      </div>
      <div className="mono" style={{ fontSize: 22, fontWeight: 500, letterSpacing: "-0.02em", whiteSpace: "nowrap", color: pnlColor(value) }}>
        {formatPnl(value, pnlMode)}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-faint)" }}>{sub}</div>
    </div>
  );
}

import { useNavigate } from "react-router-dom";
import { Header } from "../components/Header";
import { PnlModeToggle } from "../components/PnlModeToggle";
import { Sparkline } from "../components/Sparkline";
import { TickerTape } from "../components/TickerTape";
import { useAppState } from "../context/AppState";
import {
  STRATEGIES,
  dec,
  formatPnl,
  money,
  pnlColor,
  periodPnlFor,
  type BookRow,
} from "../data/mockData";

export function LabView() {
  const navigate = useNavigate();
  const { pnlMode, eodAutoClose, liveMarket, realLabStrategies } = useAppState();
  const { book, strategySums, equityCurves, todayRank, positionsToClose } = liveMarket;

  return (
    <>
      <Header kicker="AMBIENTE DI TEST" title="Tre strategie, un solo portafoglio" />
      <TickerTape />
      <div style={{ padding: "22px 30px 40px", display: "flex", flexDirection: "column", gap: 20 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(290px, 1fr))", gap: 14 }}>
          {STRATEGIES.map((s, i) => {
            const sum = strategySums[i];
            const rank = todayRank[i];
            const net = sum.unrealized + sum.realized;
            const hasRealData = Boolean(realLabStrategies[s.id]);
            return (
              <div key={s.id} className="card" style={{ padding: "16px 16px 14px", display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10, minHeight: 100 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <div className="mono" style={{ fontSize: 10, letterSpacing: "0.13em", color: "var(--text-faint)" }}>
                        {s.code}
                      </div>
                      <div
                        className="mono"
                        title={hasRealData ? "Posizioni reali da lab_positions" : "Nessuna posizione reale ancora: dati simulati"}
                        style={{
                          fontSize: 8.5,
                          letterSpacing: "0.08em",
                          padding: "2px 5px",
                          borderRadius: 4,
                          whiteSpace: "nowrap",
                          background: hasRealData ? "var(--green-tint)" : "var(--fill-neutral)",
                          color: hasRealData ? "var(--green-ink)" : "var(--text-faint)",
                        }}
                      >
                        {hasRealData ? "REALE" : "SIMULATO"}
                      </div>
                    </div>
                    <div style={{ fontSize: 16, fontWeight: 500, letterSpacing: "-0.01em", lineHeight: 1.25 }}>{s.name}</div>
                    <div style={{ fontSize: 11.5, color: "var(--text-secondary-2)", lineHeight: 1.45 }}>{s.logic}</div>
                  </div>
                  <div
                    className="badge"
                    style={{
                      background: rank === 0 ? "var(--green-tint)" : "var(--fill-neutral)",
                      color: rank === 0 ? "var(--green-ink)" : "var(--text-faint)",
                    }}
                  >
                    {rank === 0 ? "MIGLIORE OGGI" : `#${rank + 1} OGGI`}
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "flex-end", gap: 18, flexWrap: "wrap" }}>
                  <Metric label="REALIZED" value={money(sum.realized)} color={pnlColor(sum.realized)} />
                  <Metric label="UNREALIZED" value={money(sum.unrealized)} color={pnlColor(sum.unrealized)} />
                </div>

                <div style={{ height: 46, margin: "0 -4px" }}>
                  <Sparkline values={equityCurves[i]} color={net >= 0 ? "var(--green-ink)" : "var(--red-ink)"} />
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(56px, 1fr))",
                    gap: "10px 8px",
                    borderTop: "1px solid var(--border-divider)",
                    paddingTop: 12,
                  }}
                >
                  <Stat k="OP" v={String(s.backtest.tradesPerSession)} />
                  <Stat k="WIN" v={`${Math.round(s.backtest.winRate * 100)}%`} />
                  <Stat k="SHARPE" v={dec(s.backtest.sharpe, 2)} />
                  <Stat k="COSTI" v={`−${s.backtest.costs}`} />
                </div>

                <div className="btn-secondary" onClick={() => navigate(`/strategie/${s.id}`)}>
                  Parametri e backtest
                </div>
              </div>
            );
          })}
        </div>

        <div className="card" style={{ overflow: "hidden" }}>
          <div
            style={{
              padding: "15px 18px",
              borderBottom: "1px solid var(--border-divider)",
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 3, flex: "1 1 240px", minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 500 }}>P&amp;L realized per periodo</div>
              <div style={{ fontSize: 11.5, color: "var(--text-secondary-2)" }}>
                Solo utili e perdite effettivamente incassati, costi dedotti. Il conto reale usa ogni giorno la
                strategia scelta al mattino.
              </div>
            </div>
            <PnlModeToggle />
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(130px, 1.5fr) repeat(4, minmax(86px, 1fr))",
              alignItems: "center",
              padding: "0 18px",
              height: 34,
              background: "var(--bg-subtle)",
              borderBottom: "1px solid var(--border-divider)",
            }}
          >
            <div className="table-header-cell">PORTAFOGLIO</div>
            <div className="table-header-cell" style={{ textAlign: "right" }}>ULT. GIORNATA</div>
            <div className="table-header-cell" style={{ textAlign: "right" }}>SETT. PREC.</div>
            <div className="table-header-cell" style={{ textAlign: "right" }}>MESE PREC.</div>
            <div className="table-header-cell" style={{ textAlign: "right" }}>DA INIZIO</div>
          </div>

          {STRATEGIES.map((s) => {
            const p = periodPnlFor(s.code.toLowerCase().replace(" ", "-"));
            return <PnlRow key={s.id} label={s.code} sub={s.shortName} p={p} pnlMode={pnlMode} />;
          })}
          <PnlRow label="REALE" sub="conto Alpaca" p={periodPnlFor("real")} pnlMode={pnlMode} highlight />
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            flexWrap: "wrap",
            background: "var(--green-tint)",
            border: "1px solid var(--green-border)",
            borderRadius: 10,
            padding: "12px 16px",
          }}
        >
          <div className="mono" style={{ fontSize: 10, letterSpacing: "0.12em", color: "var(--green-ink)", whiteSpace: "nowrap" }}>
            REGOLA EOD
          </div>
          <div style={{ fontSize: 12.5, flex: "1 1 240px", minWidth: 0 }}>
            {eodAutoClose
              ? "Tutte le posizioni con unrealized positivo vengono chiuse all'ultima asta, su tutti e tre i portafogli laboratorio e sul conto reale."
              : "Chiusura automatica disattivata: le posizioni restano aperte oltre la seduta e il confronto tra strategie perde validità."}
          </div>
          <div
            className="mono"
            style={{
              fontSize: 12,
              padding: "5px 10px",
              borderRadius: 6,
              background: "#ffffff",
              border: "1px solid var(--green-border)",
              color: "var(--green-ink)",
              whiteSpace: "nowrap",
            }}
          >
            {positionsToClose} da chiudere
          </div>
        </div>

        <CompositionTable book={book} totals={strategySums} />
      </div>
    </>
  );
}

function Metric({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <div className="mono" style={{ fontSize: 9.5, letterSpacing: "0.11em", color: "var(--text-faint)" }}>
        {label}
      </div>
      <div className="mono" style={{ fontSize: 23, fontWeight: 500, letterSpacing: "-0.02em", whiteSpace: "nowrap", color }}>
        {value}
      </div>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <div className="mono" style={{ fontSize: 9, letterSpacing: "0.08em", color: "var(--text-faint)", whiteSpace: "nowrap" }}>
        {k}
      </div>
      <div className="mono" style={{ fontSize: 13, whiteSpace: "nowrap" }}>
        {v}
      </div>
    </div>
  );
}

function PnlRow({
  label,
  sub,
  p,
  pnlMode,
  highlight,
}: {
  label: string;
  sub: string;
  p: ReturnType<typeof periodPnlFor>;
  pnlMode: "abs" | "pct";
  highlight?: boolean;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(130px, 1.5fr) repeat(4, minmax(86px, 1fr))",
        alignItems: "center",
        padding: "0 18px",
        height: 46,
        borderBottom: "1px solid var(--border-subtle)",
        background: highlight ? "var(--bg-real-row)" : "transparent",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 9, minWidth: 0, paddingRight: 10 }}>
        <div className="mono" style={{ fontSize: 12, fontWeight: 500, whiteSpace: "nowrap" }}>
          {label}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {sub}
        </div>
      </div>
      <div className="mono" style={{ fontSize: 12.5, textAlign: "right", color: pnlColor(p.lastSession) }}>
        {formatPnl(p.lastSession, pnlMode)}
      </div>
      <div className="mono" style={{ fontSize: 12.5, textAlign: "right", color: pnlColor(p.previousWeek) }}>
        {formatPnl(p.previousWeek, pnlMode)}
      </div>
      <div className="mono" style={{ fontSize: 12.5, textAlign: "right", color: pnlColor(p.previousMonth) }}>
        {formatPnl(p.previousMonth, pnlMode)}
      </div>
      <div className="mono" style={{ fontSize: 13, fontWeight: 500, textAlign: "right", color: pnlColor(p.sinceInception) }}>
        {formatPnl(p.sinceInception, pnlMode)}
      </div>
    </div>
  );
}

function CompositionTable({
  book,
  totals,
}: {
  book: BookRow[];
  totals: { unrealized: number; realized: number }[];
}) {
  return (
    <div className="card no-scrollbar-x" style={{ overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 14,
          flexWrap: "wrap",
          padding: "15px 18px",
          borderBottom: "1px solid var(--border-divider)",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 500 }}>Composizione comune</div>
          <div style={{ fontSize: 11.5, color: "var(--text-secondary-2)" }}>
            Stessi 20 titoli, stesso capitale, equal weight — l'unica variabile è la strategia.
          </div>
        </div>
        <div className="mono" style={{ fontSize: 10, letterSpacing: "0.1em", color: "var(--text-faint)", whiteSpace: "nowrap" }}>
          U = UNREAL. · R = REAL.
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(120px, 1.5fr) repeat(3, minmax(150px, 1.9fr))",
          alignItems: "center",
          padding: "0 18px",
          height: 34,
          background: "var(--bg-subtle)",
          borderBottom: "1px solid var(--border-divider)",
        }}
      >
        <div className="table-header-cell">TITOLO</div>
        {STRATEGIES.map((s) => (
          <div
            key={s.id}
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(40px, 1fr) minmax(0, 0.9fr) minmax(0, 0.9fr)",
              gap: 6,
              borderLeft: "1px solid var(--border-divider)",
              paddingLeft: 12,
            }}
          >
            <div className="table-header-cell" style={{ whiteSpace: "nowrap" }}>{s.code}</div>
            <div className="table-header-cell" style={{ textAlign: "right" }}>U</div>
            <div className="table-header-cell" style={{ textAlign: "right" }}>R</div>
          </div>
        ))}
      </div>

      {book.map((row) => (
        <div
          key={row.symbol}
          className="row-hover"
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(120px, 1.5fr) repeat(3, minmax(150px, 1.9fr))",
            alignItems: "center",
            padding: "0 18px",
            height: 42,
            borderBottom: "1px solid var(--border-subtle)",
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0, paddingRight: 10 }}>
            <div className="mono" style={{ fontSize: 12.5, fontWeight: 500 }}>{row.symbol}</div>
            <div style={{ fontSize: 11, color: "var(--text-faint)", whiteSpace: "nowrap" }}>{row.qty} pz</div>
          </div>
          {row.cells.map((c, ci) => (
            <div
              key={ci}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(40px, 1fr) minmax(0, 0.9fr) minmax(0, 0.9fr)",
                gap: 6,
                alignItems: "center",
                borderLeft: "1px solid var(--border-subtle)",
                paddingLeft: 12,
              }}
            >
              <span
                className={`chip ${c.side === "LONG" ? "chip-long" : c.side === "SHORT" ? "chip-short" : "chip-flat"}`}
                style={{ justifySelf: "start" }}
              >
                {c.side}
              </span>
              <div className="mono" style={{ fontSize: 12, textAlign: "right", color: c.side === "FLAT" ? "var(--text-disabled)" : pnlColor(c.unreal) }}>
                {c.side === "FLAT" ? "—" : money(c.unreal)}
              </div>
              <div className="mono" style={{ fontSize: 12, textAlign: "right", color: c.real === 0 ? "var(--text-disabled)" : pnlColor(c.real) }}>
                {c.real === 0 ? "—" : money(c.real)}
              </div>
            </div>
          ))}
        </div>
      ))}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(120px, 1.5fr) repeat(3, minmax(150px, 1.9fr))",
          alignItems: "center",
          padding: "0 18px",
          height: 46,
          background: "var(--bg-subtle)",
        }}
      >
        <div style={{ fontSize: 12.5, fontWeight: 500 }}>Totale seduta</div>
        {totals.map((t, i) => (
          <div
            key={i}
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(40px, 1fr) minmax(0, 0.9fr) minmax(0, 0.9fr)",
              gap: 6,
              alignItems: "center",
              borderLeft: "1px solid var(--border-divider)",
              paddingLeft: 12,
            }}
          >
            <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)", whiteSpace: "nowrap" }}>
              NET {money(t.unrealized + t.realized)}
            </div>
            <div className="mono" style={{ fontSize: 12.5, fontWeight: 500, textAlign: "right", color: pnlColor(t.unrealized) }}>
              {money(t.unrealized)}
            </div>
            <div className="mono" style={{ fontSize: 12.5, fontWeight: 500, textAlign: "right", color: pnlColor(t.realized) }}>
              {money(t.realized)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

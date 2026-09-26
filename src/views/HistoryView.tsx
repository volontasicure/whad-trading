import { Header } from "../components/Header";
import { StatusBadge } from "../components/StatusBadge";
import { TickerTape } from "../components/TickerTape";
import { useAppState } from "../context/AppState";
import { SESSIONS, STRATEGIES, STRATEGY_HISTORY_STATS, dec, money, pnlColor } from "../data/mockData";
import type { StrategyId } from "../types";

interface DisplayHistoryStat {
  strategyId: StrategyId;
  name: string;
  net: number;
  timesPicked: number;
  sharpe: number | null;
  costs: number;
}

interface DisplaySession {
  date: string;
  /** Dal 25/9/2026 può essere composito ("pairs+vwap_reversion") — mai un solo StrategyId garantito, vedi splitStrategyIds/resolveStrategyNames sopra. */
  strategyId: string;
  net: number;
  deviationPct: number;
  trades: number;
  costs: number;
}

function formatDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("it-IT", { day: "2-digit", month: "short", timeZone: "UTC" });
}

/** Dal 25/9/2026 sessions.strategy_id può essere più strategie ammesse insieme, unite da "+"
 *  (es. "pairs+vwap_reversion") — mai più assunto un singolo id valido, vedi CLAUDE.md. */
function splitStrategyIds(compositeId: string): string[] {
  return compositeId.split("+").filter(Boolean);
}

/** Nomi leggibili di un id composito, per la colonna STRATEGIA — non crasha su id non
 *  riconosciuti (fallback al segmento grezzo) e non assume mai un solo id. */
function resolveStrategyNames(compositeId: string): string {
  return splitStrategyIds(compositeId)
    .map((id) => STRATEGIES.find((s) => s.id === id)?.name ?? id)
    .join(" + ");
}

export function HistoryView() {
  const { realDebrief, debriefSource } = useAppState();
  const hasRealSessions = Boolean(realDebrief && realDebrief.sessions.length > 0);
  const status = debriefSource === "loading" || debriefSource === "offline" ? debriefSource : hasRealSessions ? "live" : "mock";

  let stats: DisplayHistoryStat[];
  let sessions: DisplaySession[];
  let tableNote: string;

  if (hasRealSessions && realDebrief) {
    stats = STRATEGIES.map((s) => {
      // Dal 25/9/2026 più strategie possono essere ammesse lo stesso giorno (sessions.strategy_id
      // composito, es. "pairs+vwap_reversion") — "picked" ora conta le sedute con almeno questa
      // strategia ammessa, e il netto di quel giorno è diviso in parti uguali tra le ammesse
      // (coerente con l'equal-weight di server/strategyAllocation.ts, ma resta un'approssimazione:
      // non c'è un netto per-strategia salvato per i giorni condivisi).
      const picks = realDebrief.sessions.filter((h) => splitStrategyIds(h.strategyId).includes(s.id));
      return {
        strategyId: s.id,
        name: s.name,
        net: picks.reduce((acc, h) => acc + h.net / splitStrategyIds(h.strategyId).length, 0),
        timesPicked: picks.length,
        sharpe: null,
        costs: picks.reduce((acc, h) => acc + h.costs, 0),
      };
    });
    sessions = realDebrief.sessions.map((h) => ({
      date: formatDate(h.tradingDate),
      strategyId: h.strategyId,
      net: h.net,
      deviationPct: h.deviationPct,
      trades: h.trades,
      costs: h.costs,
    }));
    tableNote = `Strategie ammesse al capitale reale ogni giorno (dal 25/9/2026, anche più insieme) e risultato lab corrispondente (${realDebrief.sessions.length} sedut${realDebrief.sessions.length === 1 ? "a" : "e"} reali).`;
  } else {
    stats = STRATEGY_HISTORY_STATS.map((s) => ({
      strategyId: s.strategyId,
      name: s.name,
      net: s.netOver10Sessions,
      timesPicked: s.timesPicked,
      sharpe: s.sharpe,
      costs: s.costs,
    }));
    sessions = SESSIONS.map((h) => ({
      date: h.date,
      strategyId: h.strategyId,
      net: h.net,
      deviationPct: h.deviationPct,
      trades: h.trades,
      costs: h.costs,
    }));
    tableNote = "Strategia scelta ogni mattina e risultato reale, confrontato con il portafoglio laboratorio corrispondente (dati simulati, nessuno storico reale ancora).";
  }

  return (
    <>
      <Header kicker="ARCHIVIO" title="Storico e analytics" />
      <TickerTape />
      <div style={{ padding: "22px 30px 40px", display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <StatusBadge
            status={status}
            title={
              status === "offline"
                ? "/api/debrief non raggiungibile: dati simulati"
                : status === "loading"
                  ? "Prima lettura dello storico in corso"
                  : hasRealSessions
                    ? "Sedute reali da sessions"
                    : "Nessuno storico reale ancora: dati simulati"
            }
          />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 14 }}>
          {stats.map((s) => (
            <div key={s.strategyId} className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ fontSize: 14, fontWeight: 500, lineHeight: 1.25, minHeight: 36 }}>{s.name}</div>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <div className="mono" style={{ fontSize: 9, letterSpacing: "0.08em", color: "var(--text-faint)" }}>
                    P&amp;L {hasRealSessions ? realDebrief!.sessions.length : 10} SEDUTE
                  </div>
                  <div className="mono" style={{ fontSize: 21, fontWeight: 500, whiteSpace: "nowrap", color: pnlColor(s.net) }}>
                    {money(s.net)}
                  </div>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(64px, 1fr))", gap: 10, borderTop: "1px solid var(--border-divider)", paddingTop: 12 }}>
                <MiniStat k="SCELTA" v={`${s.timesPicked} / ${hasRealSessions ? realDebrief!.sessions.length : 10}`} />
                <MiniStat k="SHARPE" v={s.sharpe == null ? "n/d" : dec(s.sharpe, 2)} />
                <MiniStat k="COSTI" v={`−${s.costs}`} />
              </div>
            </div>
          ))}
        </div>

        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ padding: "15px 18px", borderBottom: "1px solid var(--border-divider)", display: "flex", flexDirection: "column", gap: 3 }}>
            <div style={{ fontSize: 15, fontWeight: 500 }}>Storico sedute</div>
            <div style={{ fontSize: 11.5, color: "var(--text-secondary-2)" }}>{tableNote}</div>
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
          {sessions.map((h, i) => {
            const stratName = resolveStrategyNames(h.strategyId);
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
                <div style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: 10 }}>{stratName}</div>
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

import { useNavigate } from "react-router-dom";
import { Header } from "../components/Header";
import { StatusBadge } from "../components/StatusBadge";
import { TickerTape } from "../components/TickerTape";
import { useAppState } from "../context/AppState";
import { BACKTEST_ORDER, BEST_STRATEGY_INDEX, DEBRIEF, STRATEGIES, dec, money } from "../data/mockData";

interface DisplayRankEntry {
  strategyId: string;
  name: string;
  note: string;
  /** Etichetta pronta per la UI: netto reale in € per i dati reali, punteggio 0-20 per il fallback finto. */
  scoreLabel: string;
  /** 0-100, per la barra. */
  barPct: number;
}

interface DisplayAllocationEntry {
  strategyId: string;
  name: string;
  note: string;
  eligible: boolean;
  reason: string;
  /** 0-100. */
  weightPct: number;
}

export function DebriefView() {
  const navigate = useNavigate();
  const { confirmed, autoConfirm, confirmChoice, realDebrief, debriefSource } = useAppState();

  const isConfirmed = confirmed || autoConfirm;
  const hasRealRanking = Boolean(realDebrief && realDebrief.sessionsUsed > 0);

  let ranking: DisplayRankEntry[];
  let allocation: DisplayAllocationEntry[];
  let basisLine: string;

  if (hasRealRanking && realDebrief) {
    const maxAbsNet = Math.max(1, ...realDebrief.ranking.map((e) => Math.abs(e.net)));
    ranking = realDebrief.ranking.map((e) => {
      const s = STRATEGIES.find((st) => st.id === e.strategyId);
      return {
        strategyId: e.strategyId,
        name: s?.name ?? e.strategyId,
        note: s?.note ?? "",
        scoreLabel: `${money(e.net)} $`,
        barPct: Math.max(0, (e.net / maxAbsNet) * 100),
      };
    });
    // Dal 25/9/2026 (server/strategyAllocation.ts): il capitale reale non va più a un'unica
    // proposta esclusiva — più strategie possono essere ammesse insieme, ciascuna con un peso.
    allocation = realDebrief.allocation.map((a) => {
      const s = STRATEGIES.find((st) => st.id === a.strategyId);
      return {
        strategyId: a.strategyId,
        name: s?.name ?? a.strategyId,
        note: s?.note ?? "",
        eligible: a.eligible,
        reason: a.reason,
        weightPct: Math.round(a.weight * 100),
      };
    });
    basisLine = `Punteggio sulle ultime ${realDebrief.sessionsUsed} sedut${realDebrief.sessionsUsed === 1 ? "a" : "e"} reali: P&L netto realizzato (lab_positions), solo informativo — non decide più l'allocazione. Sharpe/win rate non ancora calcolati sul reale.`;
  } else {
    ranking = BACKTEST_ORDER.map((o, k) => {
      const s = STRATEGIES[o.i];
      const entry = DEBRIEF.ranking[k];
      return {
        strategyId: s.id,
        name: s.name,
        note: s.note,
        scoreLabel: dec(entry.score, 1),
        barPct: (entry.score / 20) * 100,
      };
    });
    // Nessun dato reale di allocazione ancora — fallback illustrativo: il migliore del backtest
    // finto al 100%, gli altri due esclusi.
    allocation = STRATEGIES.map((s, i) => ({
      strategyId: s.id,
      name: s.name,
      note: s.note,
      eligible: i === BEST_STRATEGY_INDEX,
      reason: i === BEST_STRATEGY_INDEX ? "migliore nel backtest simulato" : "non la migliore nel backtest simulato",
      weightPct: i === BEST_STRATEGY_INDEX ? 100 : 0,
    }));
    basisLine = "Punteggio su 20 sedute (dati simulati, nessuno storico reale ancora): P&L netto al netto dei costi, Sharpe, % vincenti e coerenza con il regime di volatilità attesa.";
  }

  const allocatedNames = allocation.filter((a) => a.weightPct > 0).map((a) => a.name);
  const headline = allocatedNames.length > 0 ? allocatedNames.join(" + ") : "Nessuna strategia ammessa oggi";
  const weightByStrategy = new Map(allocation.map((a) => [a.strategyId, a.weightPct]));
  const firstAllocatedId = allocation.find((a) => a.weightPct > 0)?.strategyId ?? allocation[0]?.strategyId;

  return (
    <>
      <Header kicker="PRE-APERTURA" title="Debriefing del mattino" />
      <TickerTape />
      <div style={{ padding: "22px 30px 40px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))", gap: 18, alignItems: "start" }}>
        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ padding: "16px 18px", borderBottom: "1px solid var(--border-divider)", display: "flex", flexDirection: "column", gap: 3 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ fontSize: 15, fontWeight: 500 }}>Classifica del debriefing</div>
              <StatusBadge
                status={debriefSource}
                title={
                  debriefSource === "offline"
                    ? "/api/debrief non raggiungibile: classifica su backtest finto"
                    : debriefSource === "loading"
                      ? "Prima lettura della classifica in corso"
                      : hasRealRanking
                        ? "Netto reale da lab_positions"
                        : "Nessuno storico reale ancora: classifica su backtest finto"
                }
              />
            </div>
            <div style={{ fontSize: 11.5, color: "var(--text-secondary-2)" }}>{basisLine}</div>
          </div>
          {ranking.map((entry, k) => {
            // Dal 25/9/2026 più strategie possono essere ammesse insieme (server/
            // strategyAllocation.ts) — il badge segue il peso reale di oggi, non la posizione
            // in classifica né una singola proposta esclusiva.
            const weightPct = weightByStrategy.get(entry.strategyId) ?? 0;
            const isAllocated = weightPct > 0;
            return (
              <div key={entry.strategyId} style={{ padding: "16px 18px", borderBottom: "1px solid var(--border-subtle)", display: "flex", flexDirection: "column", gap: 11 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <div className="mono" style={{ fontSize: 12, color: "var(--text-faint)" }}>{"0" + (k + 1)}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: "1 1 180px" }}>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{entry.name}</div>
                    <div style={{ fontSize: 11.5, color: "var(--text-secondary-2)" }}>{entry.note}</div>
                  </div>
                  <div
                    className="badge"
                    style={{
                      background: isAllocated ? "var(--green-tint)" : "var(--fill-neutral)",
                      color: isAllocated ? "var(--green-ink)" : "var(--text-faint)",
                    }}
                  >
                    {isAllocated ? `AMMESSA ${weightPct}%` : "ESCLUSA"}
                  </div>
                  <div className="mono" style={{ fontSize: 18, fontWeight: 500, textAlign: "right" }}>
                    {entry.scoreLabel}
                  </div>
                </div>
                <div style={{ height: 6, borderRadius: 4, background: "#f0f0ec", overflow: "hidden" }}>
                  <div style={{ height: 6, borderRadius: 4, width: `${entry.barPct}%`, background: isAllocated ? "var(--accent)" : "#dcdbd5" }} />
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div className="card" style={{ borderColor: "var(--green-border)", padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="mono" style={{ fontSize: 10, letterSpacing: "0.13em", color: "var(--green-ink)" }}>
              ALLOCAZIONE REALE DI OGGI
            </div>
            <div style={{ fontSize: 21, fontWeight: 500, letterSpacing: "-0.015em" }}>{headline}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {allocation.map((a) => (
                <div key={a.strategyId} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{a.name}</div>
                    <div className="mono" style={{ fontSize: 13, color: a.weightPct > 0 ? "var(--green-ink)" : "var(--text-faint)" }}>
                      {a.weightPct > 0 ? `${a.weightPct}%` : "esclusa"}
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-secondary-2)" }}>{a.weightPct > 0 ? a.note : a.reason}</div>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 10.5, color: "var(--text-faint)", borderTop: "1px solid var(--border-divider)", paddingTop: 10 }}>
              Capitale reale diviso equamente tra le strategie ammesse (storico minimo in paper + drawdown recente sotto soglia — server/strategyAllocation.ts), non più un'unica proposta.
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
              <div className="btn-secondary" style={{ flex: "0 1 auto", padding: "11px 14px" }} onClick={() => navigate(firstAllocatedId ? `/strategie/${firstAllocatedId}` : "/lab")}>
                Vedi il laboratorio
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

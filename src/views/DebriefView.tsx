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

export function DebriefView() {
  const navigate = useNavigate();
  const { confirmed, autoConfirm, confirmChoice, realDebrief, debriefSource } = useAppState();

  const isConfirmed = confirmed || autoConfirm;
  const hasRealRanking = Boolean(realDebrief && realDebrief.sessionsUsed > 0 && realDebrief.proposedStrategyId);

  let ranking: DisplayRankEntry[];
  let proposedName: string;
  let proposedNote: string;
  let proposedId: string;
  let proposalLine: string;
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
    const top = realDebrief.ranking[0];
    // La proposta non è più necessariamente il primo della classifica (vedi PROPOSED_STRATEGY_ID
    // in server/debrief.ts) — il netto mostrato deve essere quello della strategia proposta,
    // non quello del primo in classifica, altrimenti motivazione e numero non coincidono.
    const proposedEntry = realDebrief.ranking.find((e) => e.strategyId === realDebrief.proposedStrategyId) ?? top;
    const proposed = STRATEGIES.find((s) => s.id === realDebrief.proposedStrategyId);
    proposedName = proposed?.name ?? proposedEntry.strategyId;
    proposedNote = proposed?.note ?? "";
    proposedId = proposed?.id ?? proposedEntry.strategyId;
    proposalLine = `${proposedNote} Netto reale sulle ultime ${realDebrief.sessionsUsed} sedut${realDebrief.sessionsUsed === 1 ? "a" : "e"}: ${money(proposedEntry.net)} $.`;
    basisLine = `Punteggio sulle ultime ${realDebrief.sessionsUsed} sedut${realDebrief.sessionsUsed === 1 ? "a" : "e"} reali: P&L netto realizzato (lab_positions). Sharpe/win rate non ancora calcolati sul reale.`;
  } else {
    const best = STRATEGIES[BEST_STRATEGY_INDEX];
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
    proposedName = best.name;
    proposedNote = best.note;
    proposedId = best.id;
    proposalLine = `${best.note} Netto più alto sulle ultime 20 sedute: ${money(BACKTEST_ORDER[0].net)} $ dopo i costi, Sharpe ${dec(best.backtest.sharpe, 2)}.`;
    basisLine = "Punteggio su 20 sedute (dati simulati, nessuno storico reale ancora): P&L netto al netto dei costi, Sharpe, % vincenti e coerenza con il regime di volatilità attesa.";
  }

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
            // La proposta non è più per forza il primo della classifica (vedi PROPOSED_STRATEGY_ID
            // in server/debrief.ts) — il badge deve seguire la strategia proposta, non la posizione.
            const isProposed = entry.strategyId === proposedId;
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
                      background: isProposed ? "var(--green-tint)" : "var(--fill-neutral)",
                      color: isProposed ? "var(--green-ink)" : "var(--text-faint)",
                    }}
                  >
                    {isProposed ? "PROPOSTA" : "IN ATTESA"}
                  </div>
                  <div className="mono" style={{ fontSize: 18, fontWeight: 500, textAlign: "right" }}>
                    {entry.scoreLabel}
                  </div>
                </div>
                <div style={{ height: 6, borderRadius: 4, background: "#f0f0ec", overflow: "hidden" }}>
                  <div style={{ height: 6, borderRadius: 4, width: `${entry.barPct}%`, background: isProposed ? "var(--accent)" : "#dcdbd5" }} />
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
            <div style={{ fontSize: 21, fontWeight: 500, letterSpacing: "-0.015em" }}>{proposedName}</div>
            <div style={{ fontSize: 12.5, color: "var(--text-secondary-2)", lineHeight: 1.5 }}>{proposalLine}</div>
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
            {(!hasRealRanking || true) && (
              <div style={{ fontSize: 10.5, color: "var(--text-faint)" }}>Confidenza e regime VIX: ancora simulati, non calcolati sul reale.</div>
            )}
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
              <div className="btn-secondary" style={{ flex: "0 1 auto", padding: "11px 14px" }} onClick={() => navigate(`/strategie/${proposedId}`)}>
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

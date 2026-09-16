import { Header } from "../components/Header";
import { TickerTape } from "../components/TickerTape";
import { useAppState } from "../context/AppState";
import { useAlpacaStatus } from "../hooks/useAlpacaStatus";
import { BROKERS, CAPITAL, MARKET, SESSION_RULES } from "../data/mockData";

export function RulesView() {
  const { eodAutoClose, autoConfirm } = useAppState();
  const { data: alpacaStatus } = useAlpacaStatus();
  const brokers = BROKERS.map((b) => (b.id === "alpaca" ? alpacaStatus : b));

  const eodRules = [
    {
      label: "Chiusura delle posizioni in profitto",
      hint: "Ogni posizione con unrealized > 0 viene liquidata all'ultima asta",
      value: eodAutoClose ? "attiva" : "disattiva",
      bg: eodAutoClose ? "var(--green-tint)" : "var(--red-tint)",
      fg: eodAutoClose ? "var(--green-ink)" : "var(--red-ink)",
    },
    {
      label: "Posizioni in perdita",
      hint: "Restano aperte solo se la strategia lo prevede, altrimenti liquidate",
      value: "da strategia",
      bg: "var(--fill-neutral)",
      fg: "var(--text-primary)",
    },
    {
      label: "Orario di esecuzione",
      hint: "Invio ordini in chiusura d'asta",
      value: SESSION_RULES.eodOrderTime,
      bg: "var(--fill-neutral)",
      fg: "var(--text-primary)",
    },
    {
      label: "Debriefing serale",
      hint: "Confronta i tre portafogli lab e aggiorna i punteggi",
      value: SESSION_RULES.debriefTime,
      bg: "var(--fill-neutral)",
      fg: "var(--text-primary)",
    },
  ];

  const labRules = [
    {
      label: "Capitale per portafoglio laboratorio",
      hint: "Identico sui tre lab per rendere confrontabile la strategia",
      value: `${CAPITAL.toLocaleString("it-IT")} $`,
    },
    {
      label: "Universo investibile",
      hint: "Stessi titoli su lab e conto reale, equal weight",
      value: `${MARKET.length} titoli · ${(100 / MARKET.length).toFixed(1)}%`,
    },
    {
      label: "Selezione strategia del mattino",
      hint: autoConfirm ? "Il sistema attiva la migliore senza intervento" : "Il sistema propone, l'operatore conferma",
      value: autoConfirm ? "automatica" : "con conferma",
    },
    {
      label: "Allineamento dei lab",
      hint: "A inizio seduta i tre portafogli ripartono dalla stessa composizione",
      value: "ogni mattina",
    },
  ];

  return (
    <>
      <Header kicker="CONFIGURAZIONE" title="Regole e broker" />
      <TickerTape />
      <div style={{ padding: "22px 30px 40px", display: "flex", flexDirection: "column", gap: 18, maxWidth: 920 }}>
        <div className="card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <div style={{ fontSize: 15, fontWeight: 500 }}>Chiusura di fine giornata</div>
            <div style={{ fontSize: 11.5, color: "var(--text-secondary-2)" }}>
              Applicata sia ai portafogli laboratorio sia al conto reale, così il confronto resta valido.
            </div>
          </div>
          {eodRules.map((r, i) => (
            <RuleRow key={i} label={r.label} hint={r.hint} value={r.value} bg={r.bg} fg={r.fg} />
          ))}
        </div>

        <div className="card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 15, fontWeight: 500 }}>Regole del laboratorio</div>
          {labRules.map((r, i) => (
            <RuleRow key={i} label={r.label} hint={r.hint} value={r.value} bg="var(--fill-neutral)" fg="var(--text-primary)" />
          ))}
        </div>

        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ padding: "15px 18px", borderBottom: "1px solid var(--border-divider)", fontSize: 15, fontWeight: 500 }}>
            Broker collegati
          </div>
          {brokers.map((b) => (
            <div key={b.id} style={{ padding: "14px 18px", borderBottom: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
              <div
                className="mono"
                style={{
                  width: 36,
                  height: 36,
                  flex: "0 0 auto",
                  borderRadius: 10,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 13,
                  fontWeight: 600,
                  background: b.connected ? "var(--green-tint)" : "var(--fill-neutral)",
                  color: b.connected ? "var(--green-ink)" : "var(--text-faint)",
                }}
              >
                {b.displayName[0]}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0, flex: "1 1 160px" }}>
                <div style={{ fontSize: 14, fontWeight: 500 }}>{b.displayName}</div>
                <div className="mono" style={{ fontSize: 11.5, color: "var(--text-faint)" }}>{b.maskedKey}</div>
              </div>
              <div
                className="mono"
                style={{
                  fontSize: 10,
                  padding: "5px 9px",
                  borderRadius: 6,
                  whiteSpace: "nowrap",
                  background: b.connected ? "var(--green-tint)" : "var(--fill-neutral)",
                  color: b.connected ? "var(--green-ink)" : "var(--text-faint)",
                }}
              >
                {b.connected ? "CONNESSO" : "NON CONFIG."}
              </div>
              <div className="btn-secondary" style={{ padding: "8px 13px", whiteSpace: "nowrap" }}>
                {b.connected ? "Gestisci" : "Collega"}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function RuleRow({ label, hint, value, bg, fg }: { label: string; hint: string; value: string; bg: string; fg: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, borderTop: "1px solid var(--border-subtle)", paddingTop: 12 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: "1 1 auto", minWidth: 0 }}>
        <div style={{ fontSize: 13 }}>{label}</div>
        <div style={{ fontSize: 11.5, color: "var(--text-faint)" }}>{hint}</div>
      </div>
      <div className="mono" style={{ fontSize: 12, padding: "5px 10px", borderRadius: 6, whiteSpace: "nowrap", background: bg, color: fg }}>
        {value}
      </div>
    </div>
  );
}

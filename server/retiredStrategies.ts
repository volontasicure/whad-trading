// Strategie spente anche nel laboratorio (nessun nuovo ingresso; le posizioni già aperte escono con le loro regole
// normali, ORB e VWAP comunque entro la chiusura di fine giornata). Dal 22/10/2026, su decisione di Nicola dopo il
// backtest di produzione su 10 anni (CLAUDE.md, "Ridisegno integrale"): ORB −7,9%/anno, negativo in tutti i 10 anni;
// VWAP +1,6%/anno ma Sharpe in eccesso dei T-bill −0,10, guadagno solo nel 2020. Erano già fuori dal capitale reale
// dall'11/10/2026 (REAL_CAPITAL_STRATEGIES in server/strategyAllocation.ts). Il codice resta, riaccendibile togliendo
// la riga qui (e `retiredOn` in src/data/mockData.ts), ma solo con nuove prove su più finestre indipendenti.
export const RETIRED_LAB_STRATEGIES: Record<string, string> = {
  orb: "2026-10-22",
  vwap_reversion: "2026-10-22",
};

export function isRetired(strategyId: string): boolean {
  return strategyId in RETIRED_LAB_STRATEGIES;
}

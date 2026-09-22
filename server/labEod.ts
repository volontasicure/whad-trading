// Chiusura di fine giornata per posizioni singole (ORB, VWAP) — mai per le gambe di una
// coppia, quelle usano decidePairsEodCloses in pairsTrading.ts.
//
// Fino al 21/9/2026 la regola era generica per ogni strategia: "chiudi solo se in utile"
// (era anche il comportamento delle gambe pairs, vedi sotto). Backtest A/B su due finestre
// storiche (checkpoint 22/9/2026, scripts/backtest.ts EXP_EOD_CLOSE_ALL/_SINGLES) hanno
// confrontato tre regole sul P&L lab aggregato:
//   attuale (chiudi se in utile, ovunque):        recente +4.012 / fuori campione +2.230
//   chiudi tutto (anche i pairs):                 recente +4.386 / fuori campione   +657
//   chiudi tutto solo su ORB/VWAP, pairs invariato: recente +4.411 / fuori campione +3.018
// Solo la terza migliora su ENTRAMBE le finestre. Chiudere sempre ORB/VWAP ha senso: la loro
// uscita è legata a un livello di prezzo/tempo dentro la giornata, non c'è motivo di tenerle
// aperte la notte (vedi NKE, aperta il 18/9 e stoppata solo il 22/9). Chiudere sempre anche i
// pairs invece taglia le coppie a metà della reversione dello z-score — un processo che può
// richiedere più di una seduta — e quasi raddoppia gli ingressi (uscita anticipata → slot
// libero → nuovo ingresso il giorno dopo), motivo per cui restano sulla regola "solo se in
// utile combinato" (decidePairsEodCloses).
export type Side = "LONG" | "SHORT";

export interface LabOpenRow {
  id: number;
  symbol: string;
  side: Side;
  qty: number;
  entryPrice: number;
}

export interface LabEodClose {
  id: number;
  exitPrice: number;
  realizedPnl: number;
}

/** Chiude ogni riga (posizione singola, mai una gamba pairs), dato il prezzo corrente per simbolo. */
export function decideLabEodCloses(openRows: LabOpenRow[], prices: Record<string, number>): LabEodClose[] {
  const closes: LabEodClose[] = [];
  for (const row of openRows) {
    const price = prices[row.symbol];
    if (price == null) continue;
    const dir = row.side === "LONG" ? 1 : -1;
    const unrealized = row.qty * (price - row.entryPrice) * dir;
    closes.push({ id: row.id, exitPrice: price, realizedPnl: Math.round(unrealized) });
  }
  return closes;
}

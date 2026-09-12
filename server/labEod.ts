// Chiusura di fine giornata per i laboratori: "tutte le posizioni con unrealized positivo
// vengono chiuse all'ultima asta, sia nei lab sia sul conto reale" (regola di dominio).
// Generica per strategia: opera sulla forma comune di lab_positions (qty/side/entry_price),
// usata sia per posizioni singole (ORB, VWAP) sia per le singole gambe di una coppia.

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

/** Chiude ogni riga con unrealized positivo, dato il prezzo corrente per simbolo. */
export function decideLabEodCloses(openRows: LabOpenRow[], prices: Record<string, number>): LabEodClose[] {
  const closes: LabEodClose[] = [];
  for (const row of openRows) {
    const price = prices[row.symbol];
    if (price == null) continue;
    const dir = row.side === "LONG" ? 1 : -1;
    const unrealized = row.qty * (price - row.entryPrice) * dir;
    if (unrealized <= 0) continue;
    closes.push({ id: row.id, exitPrice: price, realizedPnl: Math.round(unrealized) });
  }
  return closes;
}

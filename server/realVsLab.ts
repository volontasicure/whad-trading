// Controlli di coerenza tra conto reale e laboratori, usati da scripts/monitor.ts.
//
// Il conto reale dovrebbe essere una copia dei lab ammessi, nelle proporzioni decise al
// mattino (server/strategyAllocation.ts). Quando i due si separano, quasi mai è colpa della
// strategia: è un problema di esecuzione (size, ordini doppi, chiusure mancate). Finora ogni
// episodio di questo tipo è stato scoperto giorni dopo:
//   - 16-18/9: reale −4.298$ contro lab −135$ (size 2× la baseline);
//   - 30/9: doppia chiusura di BA → corto da 32 azioni mai registrato in real_positions;
//   - 30/9-1/10: gamba BAC orfana, nessun percorso di chiusura;
//   - 24-28/9: EOD reale che non scattava più, posizioni tenute la notte.
// Tre controlli, tutti pura logica (nessun I/O) — l'I/O resta in scripts/monitor.ts:
//   1. riconciliazione broker ↔ DB (posizioni Alpaca vs real_positions aperte);
//   2. trade reali chiusi oggi senza un corrispondente nel lab (stessa strategia/simbolo/lato);
//   3. scostamento di P&L realizzato oggi tra reale e lab, scalato per capitale e peso.
//
// Nessuno di questi tocca segnali o parametri di strategia, e nessuna soglia è tarata su un
// risultato di backtest: sono controlli di correttezza dell'esecuzione.

export type Side = "LONG" | "SHORT";

export interface BrokerPosition {
  symbol: string;
  /** Quantità con segno, come la restituisce Alpaca: negativa per gli short. */
  signedQty: number;
}

export interface DbOpenPosition {
  symbol: string;
  side: Side;
  qty: number;
}

export interface PositionMismatch {
  symbol: string;
  brokerQty: number;
  dbQty: number;
}

/** Tolleranza per errori di arrotondamento sulle quantità frazionarie. */
const QTY_EPSILON = 1e-6;

/**
 * Confronta, simbolo per simbolo, la quantità netta con segno sul broker con la somma delle
 * righe aperte in real_positions. Qualunque differenza è un'anomalia: o il DB non sa di una
 * posizione che esiste davvero (caso BA del 30/9), o crede aperta una posizione già chiusa
 * (EOD/bracket che ha chiuso senza essere registrato).
 */
export function reconcilePositions(broker: BrokerPosition[], dbOpen: DbOpenPosition[]): PositionMismatch[] {
  const brokerBySymbol = new Map<string, number>();
  for (const p of broker) brokerBySymbol.set(p.symbol, (brokerBySymbol.get(p.symbol) ?? 0) + p.signedQty);

  const dbBySymbol = new Map<string, number>();
  for (const p of dbOpen) {
    const signed = p.side === "SHORT" ? -p.qty : p.qty;
    dbBySymbol.set(p.symbol, (dbBySymbol.get(p.symbol) ?? 0) + signed);
  }

  const symbols = new Set([...brokerBySymbol.keys(), ...dbBySymbol.keys()]);
  const out: PositionMismatch[] = [];
  for (const symbol of [...symbols].sort()) {
    const brokerQty = brokerBySymbol.get(symbol) ?? 0;
    const dbQty = dbBySymbol.get(symbol) ?? 0;
    if (Math.abs(brokerQty - dbQty) > QTY_EPSILON) out.push({ symbol, brokerQty, dbQty });
  }
  return out;
}

export interface TradeKey {
  strategyId: string;
  symbol: string;
  side: Side;
}

export interface RealClosedTrade extends TradeKey {
  realizedPnl: number;
  exitReason: string | null;
}

/**
 * Trade reali chiusi oggi per cui il lab non ha nessuna posizione (aperta o chiusa oggi)
 * con stessa strategia, simbolo e lato. Il contrario (trade lab senza copia reale) è normale
 * — ingressi prima della conferma del debriefing, titolo non shortable, strategia a peso zero —
 * e non viene segnalato. Un trade reale senza gemello nel lab, invece, è un ordine che la
 * strategia non ha mai deciso.
 *
 * Le chiusure manuali di pulizia (exit_reason che inizia per "manual_") sono escluse: sono già
 * note per costruzione.
 */
export function findUnmatchedRealTrades(realClosedToday: RealClosedTrade[], labTouchedToday: TradeKey[]): RealClosedTrade[] {
  const key = (k: TradeKey) => `${k.strategyId}|${k.symbol}|${k.side}`;
  const labKeys = new Set(labTouchedToday.map(key));
  return realClosedToday.filter((t) => !(t.exitReason ?? "").startsWith("manual_") && !labKeys.has(key(t)));
}

export interface StrategyRealizedToday {
  strategyId: string;
  /** Realized di oggi nel lab, su LAB_CAPITAL_REF di capitale. */
  labRealized: number;
  /** Realized di oggi sul conto reale per questa strategia. */
  realRealized: number;
  /** Peso di capitale reale di oggi (0 se la strategia è esclusa). */
  weight: number;
}

export interface DeviationResult {
  /** Realized reale atteso, cioè il lab scalato per capitale e peso di ogni strategia. */
  expected: number;
  actual: number;
  gap: number;
  threshold: number;
  breached: boolean;
  /** Dettaglio per strategia, per capire da dove arriva lo scostamento. */
  byStrategy: { strategyId: string; expected: number; actual: number; gap: number }[];
}

/**
 * Soglia assoluta minima: sotto questo valore lo scostamento è rumore normale (il reale
 * dimensiona per convinzione e non replica gli ingressi prima della conferma del mattino).
 */
export const MIN_DEVIATION_DOLLARS = 250;
/** Soglia relativa: 0,25% dell'equity reale — un quarto del limite di perdita giornaliero (1%). */
export const DEVIATION_PCT_OF_EQUITY = 0.25;

/**
 * Atteso = Σ realized_lab × (equity × peso / capitale_lab). Le strategie a peso zero contano
 * con atteso 0: se il reale realizza su una strategia esclusa (uscite di posizioni ereditate),
 * quello resta uno scostamento — corretto, perché è P&L che l'allocazione di oggi non prevede.
 */
export function computeDeviation(rows: StrategyRealizedToday[], realEquity: number, labCapital: number): DeviationResult {
  const byStrategy = rows.map((r) => {
    const expected = r.labRealized * ((realEquity * r.weight) / labCapital);
    return { strategyId: r.strategyId, expected, actual: r.realRealized, gap: r.realRealized - expected };
  });
  const expected = byStrategy.reduce((s, r) => s + r.expected, 0);
  const actual = byStrategy.reduce((s, r) => s + r.actual, 0);
  const gap = actual - expected;
  const threshold = Math.max(MIN_DEVIATION_DOLLARS, (realEquity * DEVIATION_PCT_OF_EQUITY) / 100);
  return { expected, actual, gap, threshold, breached: Math.abs(gap) > threshold, byStrategy };
}

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

// ---------------------------------------------------------------------------------------
// Confronto cumulativo su più sedute, e regole di avviso (persistenza + dedupe).
// ---------------------------------------------------------------------------------------

/** Un'anomalia con chiave stabile tra un controllo e il successivo (serve a persistenza e dedupe). */
export interface Anomaly {
  key: string;
  summary: string;
  suggestion: string;
}

export const CUMULATIVE_SESSIONS = 5;
/** Sotto questo numero di sedute il confronto cumulativo non ha senso e viene saltato. */
export const MIN_CUMULATIVE_SESSIONS = 3;
/**
 * Soglie di PARTENZA, non calibrate: 0,5% dell'equity con un minimo di 300$. Non c'è uno storico
 * reale-vs-lab abbastanza lungo per tararle (la piattaforma ha poche sedute con la nuova
 * allocazione), quindi vanno riviste con i numeri che questo stesso controllo raccoglie.
 * Si avvisa solo per un divario NEGATIVO (il reale rende meno di quanto i lab implicano): un
 * divario positivo resta nel riepilogo ma non è un allarme azionabile.
 */
export const CUMULATIVE_GAP_PCT_OF_EQUITY = 0.5;
export const MIN_CUMULATIVE_GAP_DOLLARS = 300;

export interface CumulativeRow {
  date: string;
  strategyId: string;
  labRealized: number;
  realRealized: number;
  /** Peso di capitale che quella strategia aveva quel giorno (0 se non ammessa). */
  weight: number;
}

export interface CumulativeResult {
  sessions: number;
  expected: number;
  actual: number;
  gap: number;
  threshold: number;
  breached: boolean;
  byStrategy: { strategyId: string; expected: number; actual: number; gap: number }[];
}

/**
 * Atteso per riga = realized_lab × equity × peso / capitale_lab, come in computeDeviation, ma
 * sommato su più sedute: coglie il divario che si accumula poco alla volta (es. −80$ al giorno)
 * e che il controllo giornaliero, con la sua soglia, non vede. L'equity è quella di oggi per
 * tutte le sedute (approssimazione di pochi punti percentuali, dichiarata).
 */
export function computeCumulativeGap(rows: CumulativeRow[], realEquity: number, labCapital: number): CumulativeResult {
  const acc = new Map<string, { expected: number; actual: number }>();
  const dates = new Set<string>();
  for (const r of rows) {
    dates.add(r.date);
    const cur = acc.get(r.strategyId) ?? { expected: 0, actual: 0 };
    cur.expected += r.labRealized * ((realEquity * r.weight) / labCapital);
    cur.actual += r.realRealized;
    acc.set(r.strategyId, cur);
  }
  const byStrategy = [...acc.entries()].map(([strategyId, v]) => ({ strategyId, expected: v.expected, actual: v.actual, gap: v.actual - v.expected }));
  const expected = byStrategy.reduce((s, r) => s + r.expected, 0);
  const actual = byStrategy.reduce((s, r) => s + r.actual, 0);
  const gap = actual - expected;
  const threshold = Math.max(MIN_CUMULATIVE_GAP_DOLLARS, (realEquity * CUMULATIVE_GAP_PCT_OF_EQUITY) / 100);
  return { sessions: dates.size, expected, actual, gap, threshold, breached: gap < -threshold, byStrategy };
}

export interface MonitorState {
  /** ISO dell'ultimo controllo eseguito, null se mai. */
  ranAt: string | null;
  /** Chiavi delle anomalie viste all'ultimo controllo (per la persistenza). */
  seenKeys: string[];
  /** Per ogni chiave già segnalata, quando (ISO). Serve a non ripetere lo stesso avviso. */
  alerted: Record<string, string>;
}

export const EMPTY_MONITOR_STATE: MonitorState = { ranAt: null, seenKeys: [], alerted: {} };
/** Il tick gira ogni 5 minuti: il controllo gira una volta ogni due tick, non a ogni giro. */
export const MIN_CHECK_INTERVAL_MS = 9 * 60_000;
/** Un'anomalia ancora aperta viene ripetuta al massimo ogni 3 ore. */
export const REALERT_AFTER_MS = 3 * 3600_000;

export function isCheckDue(state: MonitorState, nowMs: number): boolean {
  if (!state.ranAt) return true;
  return nowMs - new Date(state.ranAt).getTime() >= MIN_CHECK_INTERVAL_MS;
}

/**
 * Persistenza: si avvisa solo se la stessa anomalia è presente in DUE controlli consecutivi.
 * Le differenze transitorie sono normali (un bracket chiuso dal broker non ancora registrato dal
 * tick successivo, un ordine in fase di fill durante la chiusura di fine giornata) e non devono
 * generare mail. Dedupe: una chiave già segnalata non si ripete prima di REALERT_AFTER_MS, e
 * ricompare solo se nel frattempo è sparita (stato risolto) e poi tornata.
 */
export function decideAlerts(current: Anomaly[], state: MonitorState, nowMs: number): { toAlert: Anomaly[]; next: MonitorState } {
  const seen = new Set(state.seenKeys);
  const currentKeys = new Set(current.map((a) => a.key));
  const toAlert: Anomaly[] = [];
  const alerted: Record<string, string> = {};
  for (const [key, at] of Object.entries(state.alerted)) {
    if (currentKeys.has(key)) alerted[key] = at;
  }
  for (const a of current) {
    if (!seen.has(a.key)) continue;
    const last = alerted[a.key] ? new Date(alerted[a.key]).getTime() : null;
    if (last !== null && nowMs - last < REALERT_AFTER_MS) continue;
    toAlert.push(a);
    alerted[a.key] = new Date(nowMs).toISOString();
  }
  return { toAlert, next: { ranAt: new Date(nowMs).toISOString(), seenKeys: [...currentKeys], alerted } };
}

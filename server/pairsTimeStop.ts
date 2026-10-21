// Stop a tempo del pairs (21/10/2026): una coppia aperta da almeno MAX_HOLD_SESSIONS sedute si chiude
// (entrambe le gambe) a fine seduta, a prescindere dallo z-score. Logica pura più un lettore del
// calendario di borsa; l'esecuzione sta in api/cron/tick.ts (lab) e server/realEod.ts (conto reale).
//
// Perché (CLAUDE.md, "Correzione metodologica e revisione da trader"): le validazioni del pairs erano
// distorte dalla censura a destra — i perdenti restano aperti molto più a lungo dei vincenti (durata
// mediana 84 sedute contro 20) e la media mobile a 120 sedute sposta il "bersaglio", quindi una coppia che
// non rientra "esce a target" in perdita dopo mesi (TXN/AVGO: 240 sedute, −4.615$). Misurato su una run
// continua di 892 sedute (mar 2023 → ott 2026, 100k, netto di costi, libro portato avanti):
//   N sedute:  20      25     30      35      40      45      50     60     90    nessuno
//   P&L tot.:  9.187   6.207  10.383  10.877  12.399  10.456  8.372  7.445  8.175  7.761
//   Sharpe:    0,81    0,52   0,79    0,83    0,93    0,78    0,61   0,51   0,54   0,47
//   Drawdown:  3,2%    2,8%   2,9%    2,7%    2,5%    2,7%    2,9%   3,3%   3,9%   4,9%
// Un plateau tra 30 e 45 sedute (+35-60% di P&L, drawdown quasi dimezzato, tutti gli anni positivi). 40 è il
// centro del plateau e il valore migliore, ma tra 25 e 60 il profilo è irregolare: il risultato è un indizio
// su una sola traiettoria storica, non una prova. La valutazione a finestre da ~100 sedute (libro che riparte
// vuoto) dà il verso opposto (hold40: 9.462$ contro 11.923$); non è chiaro quale delle due misure sia più
// vicina al reale. Si giudica nel live, con la stessa misura (realizzato + non realizzato).
//
// Conteggio: la seduta di apertura conta come 1 (stessa convenzione del backtest, EXP_PAIRS_MAX_HOLD_DAYS in
// scripts/backtest.ts): alla chiusura della 40ª seduta la coppia scade. Si conta sul calendario di borsa
// reale (weekend e festivi esclusi). Nessun raffreddamento: dopo la chiusura la coppia può rientrare, come
// nel backtest.

import { alpacaFetch } from "./alpaca.js";

export const MAX_HOLD_SESSIONS = 40;

export interface PairHoldInfo {
  pairKey: string;
  /** Data (YYYY-MM-DD) della seduta di apertura — la più vecchia tra le gambe. */
  entryDate: string;
}

/** Data della seduta di un orario ISO/Date: le sedute NYSE cadono sempre dentro la stessa data UTC (13:30-21:00 UTC). */
export function sessionDateOf(time: string | Date): string {
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * Coppie scadute: aperte da almeno `maxHold` sedute alla data dell'ultima di `sessionDates`.
 * `sessionDates` = sedute di borsa in ordine, che devono comprendere OGGI e coprire la data di apertura di ogni coppia.
 */
export function expiredPairKeys(pairs: PairHoldInfo[], sessionDates: string[], maxHold: number = MAX_HOLD_SESSIONS): Set<string> {
  const out = new Set<string>();
  for (const p of pairs) {
    const held = sessionDates.filter((d) => d >= p.entryDate).length;
    if (held >= maxHold) out.add(p.pairKey);
  }
  return out;
}

interface CalendarEntry {
  date: string;
}

/** Sedute di borsa tra due date incluse, dal calendario reale di Alpaca. */
export async function fetchSessionDates(fromDate: string, toDate: string): Promise<string[]> {
  const cal = await alpacaFetch<CalendarEntry[]>(`/v2/calendar?start=${fromDate}&end=${toDate}`);
  return cal.map((c) => c.date).sort();
}

/** Coppie scadute oggi, leggendo il calendario una sola volta. Vuoto se non ci sono coppie. */
export async function findExpiredPairs(pairs: PairHoldInfo[], todayIso: string, maxHold: number = MAX_HOLD_SESSIONS): Promise<Set<string>> {
  if (pairs.length === 0) return new Set();
  const earliest = pairs.reduce((m, p) => (p.entryDate < m ? p.entryDate : m), todayIso);
  const sessions = await fetchSessionDates(earliest, todayIso);
  return expiredPairKeys(pairs, sessions, maxHold);
}

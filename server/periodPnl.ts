// Aggregati "per periodo" (ultima seduta / settimana / mese / da inizio) sul realized P&L
// reale, usati dalla tabella "P&L realized per periodo" in LabView. Finestre mobili sulle
// sedute reali chiuse, INCLUSIVE dell'ultima (stile 1D/1W/1M/ALL dei broker, non fasce
// mutuamente esclusive) — mai calendario solare: con la piattaforma live da pochi giorni,
// una vera "settimana solare precedente" sarebbe quasi sempre vuota. Settimana = ultime 5
// sedute chiuse, mese = ultime 20 (stessa convenzione di RANKING_LOOKBACK_SESSIONS in
// debrief.ts).

import { db } from "./db.js";

export interface PeriodPnl {
  lastSession: number;
  previousWeek: number;
  previousMonth: number;
  sinceInception: number;
}

const WEEK_SESSIONS = 5;
const MONTH_SESSIONS = 20;
// Margine ampio sopra i 20 giorni di mercato della finestra "mese" (weekend + festivi inclusi):
// limita la query raggruppata per data, che altrimenti scansiona tutta la storia di
// lab_positions/real_positions ad ogni chiamata pur servendo sempre e solo le ultime poche
// sedute — chiamata ogni 20-30s da api/lab/positions.ts e api/broker/pnl.ts, il costo cresce
// altrimenti senza limite con l'accumularsi dello storico. sinceInception NON usa questa
// finestra: va calcolato separatamente su tutta la storia (vedi sotto), altrimenti si
// romperebbe silenziosamente non appena la piattaforma supera i 40 giorni di vita.
const RECENT_WINDOW_DAYS = 40;

function windowSums(netByDateDesc: number[]): Omit<PeriodPnl, "sinceInception"> {
  const sum = (n: number) => netByDateDesc.slice(0, n).reduce((a, b) => a + b, 0);
  return {
    lastSession: netByDateDesc[0] ?? 0,
    previousWeek: sum(WEEK_SESSIONS),
    previousMonth: sum(MONTH_SESSIONS),
  };
}

/** Una voce per strategia con almeno una seduta chiusa in lab_positions. */
export async function computeLabPeriodPnl(): Promise<Record<string, PeriodPnl>> {
  const [recentRows, totalRows] = (await Promise.all([
    db().query(
      `SELECT strategy_id, (exit_time AT TIME ZONE 'UTC')::date AS d, sum(realized_pnl)::float8 AS net
       FROM lab_positions
       WHERE status = 'closed' AND exit_time >= now() - interval '${RECENT_WINDOW_DAYS} days'
       GROUP BY strategy_id, d ORDER BY strategy_id, d DESC`
    ),
    db().query(
      `SELECT strategy_id, sum(realized_pnl)::float8 AS total
       FROM lab_positions WHERE status = 'closed' GROUP BY strategy_id`
    ),
  ])) as unknown as [{ strategy_id: string; d: string; net: number }[], { strategy_id: string; total: number }[]];

  const byStrategy = new Map<string, number[]>();
  for (const r of recentRows) {
    if (!byStrategy.has(r.strategy_id)) byStrategy.set(r.strategy_id, []);
    byStrategy.get(r.strategy_id)!.push(r.net);
  }
  const totalByStrategy = new Map(totalRows.map((r) => [r.strategy_id, r.total]));

  const out: Record<string, PeriodPnl> = {};
  for (const [strategyId, nets] of byStrategy) {
    out[strategyId] = { ...windowSums(nets), sinceInception: totalByStrategy.get(strategyId) ?? 0 };
  }
  // Caso raro (nessuno storico recente ma un totale da inizio più vecchio dei 40 giorni):
  // includere comunque la strategia con le finestre recenti a zero.
  for (const [strategyId, total] of totalByStrategy) {
    if (!out[strategyId]) out[strategyId] = { lastSession: 0, previousWeek: 0, previousMonth: 0, sinceInception: total };
  }
  return out;
}

/**
 * Portafoglio REALE: netto realizzato vero da real_positions (ordini davvero eseguiti su
 * Alpaca, server/realExecution.ts), stesso schema di computeLabPeriodPnl ma senza
 * raggruppare per strategia — è un solo conto, non tre lab paralleli. Non usa più sessions
 * (il proxy "cosa avrebbe fatto il lab scelto", pre-esecuzione reale): ora che gli ordini
 * sono davvero piazzati, mischiare un netto finto pre-esecuzione con uno vero post-esecuzione
 * produrrebbe una serie incoerente — meglio azzerare la storia (reale = 0 prima di oggi, che
 * è anche la verità) e ripartire da qui. Stessa fonte usata anche da api/broker/pnl.ts per il
 * "Portafoglio reale" in LiveView (day/week/month/inception → lastSession/previousWeek/
 * previousMonth/sinceInception) — un'unica definizione di realized per tutta l'app, niente
 * più l'approssimazione dalla portfolio history di Alpaca (realized+unrealized mescolati).
 */
export async function computeRealPeriodPnl(): Promise<PeriodPnl> {
  const [recentRows, totalRows] = (await Promise.all([
    db().query(
      `SELECT (exit_time AT TIME ZONE 'UTC')::date AS d, sum(realized_pnl)::float8 AS net
       FROM real_positions
       WHERE status = 'closed' AND exit_time >= now() - interval '${RECENT_WINDOW_DAYS} days'
       GROUP BY d ORDER BY d DESC`
    ),
    db().query(`SELECT sum(realized_pnl)::float8 AS total FROM real_positions WHERE status = 'closed'`),
  ])) as unknown as [{ d: string; net: number }[], { total: number | null }[]];

  return { ...windowSums(recentRows.map((r) => r.net)), sinceInception: totalRows[0]?.total ?? 0 };
}

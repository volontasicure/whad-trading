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

function windowSums(netByDateDesc: number[]): PeriodPnl {
  const sum = (n: number) => netByDateDesc.slice(0, n).reduce((a, b) => a + b, 0);
  return {
    lastSession: netByDateDesc[0] ?? 0,
    previousWeek: sum(WEEK_SESSIONS),
    previousMonth: sum(MONTH_SESSIONS),
    sinceInception: netByDateDesc.reduce((a, b) => a + b, 0),
  };
}

/** Una voce per strategia con almeno una seduta chiusa in lab_positions. */
export async function computeLabPeriodPnl(): Promise<Record<string, PeriodPnl>> {
  const rows = (await db().query(
    `SELECT strategy_id, (exit_time AT TIME ZONE 'UTC')::date AS d, sum(realized_pnl)::float8 AS net
     FROM lab_positions WHERE status = 'closed'
     GROUP BY strategy_id, d ORDER BY strategy_id, d DESC`
  )) as unknown as { strategy_id: string; d: string; net: number }[];

  const byStrategy = new Map<string, number[]>();
  for (const r of rows) {
    if (!byStrategy.has(r.strategy_id)) byStrategy.set(r.strategy_id, []);
    byStrategy.get(r.strategy_id)!.push(r.net);
  }

  const out: Record<string, PeriodPnl> = {};
  for (const [strategyId, nets] of byStrategy) out[strategyId] = windowSums(nets);
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
  const rows = (await db().query(
    `SELECT (exit_time AT TIME ZONE 'UTC')::date AS d, sum(realized_pnl)::float8 AS net
     FROM real_positions WHERE status = 'closed'
     GROUP BY d ORDER BY d DESC`
  )) as unknown as { d: string; net: number }[];
  return windowSums(rows.map((r) => r.net));
}

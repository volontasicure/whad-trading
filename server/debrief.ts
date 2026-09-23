// Logica condivisa del debriefing reale, usata sia da api/debrief.ts (lettura per la UI)
// sia da api/cron/eod-close.ts (scrittura della riga sessions a fine giornata) — la stessa
// classifica deve valere in entrambi i posti, non due formule leggermente diverse.

import { db } from "./db.js";
import { STRATEGY_ID as ORB_STRATEGY_ID } from "./orb.js";
import { STRATEGY_ID as VWAP_STRATEGY_ID } from "./vwapReversion.js";
import { STRATEGY_ID as PAIRS_STRATEGY_ID } from "./pairsTrading.js";

export const STRATEGY_IDS = [ORB_STRATEGY_ID, VWAP_STRATEGY_ID, PAIRS_STRATEGY_ID] as const;
export const RANKING_LOOKBACK_SESSIONS = 20;

/**
 * Strategia proposta per il conto reale, dal 23/9/2026. Non è più "vincitore delle ultime 20
 * sedute" (il vecchio entries[0] di computeRanking): quella regola si è dimostrata non robusta
 * su due checkpoint indipendenti a 5 giorni di distanza (18/9: +2.555 recente / −356 fuori
 * campione; 23/9: +375 / −1.090, ancora negativa fuori campione) e nella pratica ha tenuto il
 * conto reale ancorato a ORB fin dal 15/9 per un solo giorno fortunato (+583) che il pairs,
 * più lento ma costante, non ha mai superato in classifica — mentre ORB è oggi negativo su
 * entrambe le finestre del backtest (−934 / −1.232). "Sempre pairs" è invece l'unica regola
 * risultata positiva in tutt'e quattro le finestre misurate finora (683/1.498 il 18/9,
 * 894/1.013 il 23/9). Rischio noto: il pairs trading non aveva ancora girato un giorno vero sul
 * conto reale prima di questo cambio — ordini a due gambe, controllo shortable, chiusura EOD
 * condizionata al P&L combinato sono verificati solo su backtest, da tenere d'occhio nei primi
 * giorni (comunque paper trading, non capitale vero). computeRanking() resta invariata e
 * continua ad alimentare solo la tabella di classifica mostrata nella UI, a scopo informativo —
 * non decide più la proposta. Rivedere questa scelta tra 1-2 settimane con più dati reali.
 */
export const PROPOSED_STRATEGY_ID: string = PAIRS_STRATEGY_ID;

export interface RankingEntry {
  strategyId: string;
  net: number;
  trades: number;
}

export interface Ranking {
  /** Ordinata per net decrescente — [0] è la proposta del debriefing. */
  entries: RankingEntry[];
  /** Quante sedute reali distinte sono entrate nel calcolo (<= RANKING_LOOKBACK_SESSIONS; 0 = nessuno storico ancora). */
  sessionsUsed: number;
}

/**
 * Classifica sul netto realizzato reale delle ultime (fino a) 20 sedute *precedenti*
 * beforeDateIso — mai la seduta in corso, che non è ancora conclusa. Richiede una query
 * separata per le date distinte perché "ultime 20 sedute" è calendario di borsa (niente
 * weekend/festivi), non un intervallo fisso di giorni.
 */
export async function computeRanking(beforeDateIso: string): Promise<Ranking> {
  const dateRows = (await db().query(
    `SELECT DISTINCT (exit_time AT TIME ZONE 'UTC')::date AS d FROM lab_positions
     WHERE status = 'closed' AND (exit_time AT TIME ZONE 'UTC')::date < $1::date
     ORDER BY d DESC LIMIT $2`,
    [beforeDateIso, RANKING_LOOKBACK_SESSIONS]
  )) as unknown as { d: string }[];

  const entries: RankingEntry[] = STRATEGY_IDS.map((strategyId) => ({ strategyId, net: 0, trades: 0 }));
  if (dateRows.length === 0) return { entries, sessionsUsed: 0 };

  const dates = dateRows.map((r) => r.d);
  const perfRows = (await db().query(
    `SELECT strategy_id, coalesce(sum(realized_pnl), 0)::float8 AS net, count(*)::int AS trades
     FROM lab_positions
     WHERE status = 'closed' AND (exit_time AT TIME ZONE 'UTC')::date = ANY($1::date[])
     GROUP BY strategy_id`,
    [dates]
  )) as unknown as { strategy_id: string; net: number; trades: number }[];

  for (const entry of entries) {
    const row = perfRows.find((r) => r.strategy_id === entry.strategyId);
    if (row) {
      entry.net = row.net;
      entry.trades = row.trades;
    }
  }
  entries.sort((a, b) => b.net - a.net);
  return { entries, sessionsUsed: dateRows.length };
}

export interface TodayResult {
  net: number;
  trades: number;
}

/** Risultato realizzato reale di una strategia per la seduta odierna (dal vero orario di apertura, mai da mezzanotte UTC). */
export async function todayResultFor(strategyId: string, sessionOpenUtc: string): Promise<TodayResult> {
  const rows = (await db()`
    SELECT coalesce(sum(realized_pnl), 0)::float8 AS net, count(*)::int AS trades
    FROM lab_positions WHERE status = 'closed' AND strategy_id = ${strategyId} AND exit_time >= ${sessionOpenUtc}
  `) as unknown as { net: number; trades: number }[];
  return { net: rows[0]?.net ?? 0, trades: rows[0]?.trades ?? 0 };
}

// Allocazione del capitale reale tra le strategie, dal 25/9/2026 — sostituisce lo schema
// "vincitore prende tutto" (un'unica PROPOSED_STRATEGY_ID, decisa da server/debrief.ts e
// finora "sempre pairs" dal 23/9). Motivo del cambio: con meno di due settimane di storia
// reale, dare il 100% del capitale a una sola strategia amplifica sull'intero conto il rumore
// di quella singola strategia (vedi ORB: -825 su NKE il 22/9, -1.154 nel lab il 24/9) — un
// problema di costruzione del portafoglio, non di segnale. Qui più strategie possono ricevere
// capitale reale insieme, ciascuna con una frazione, non un'unica proposta esclusiva.
//
// Due gate, entrambi nuovi (prima non esisteva nessun requisito prima che una strategia
// ricevesse capitale reale, oltre alla classifica del giorno):
// 1. Storico minimo in paper (lab) prima di poter ricevere capitale reale — "periodo di prova".
// 2. Uno stop automatico per singola strategia sul drawdown recente, non più una decisione
//    discrezionale presa ad hoc (come per ORB questa settimana).
//
// Il lab resta la base per queste decisioni (non real_positions): è la simulazione con più
// storia disponibile per tutte e tre le strategie fin dal 13-14/9, mentre il conto reale ha
// girato quasi sempre su una sola strategia alla volta finora.

import { db } from "./db.js";
import { STRATEGY_IDS } from "./debrief.js";

/** Capitale di riferimento di ciascun lab — stesso valore di CAPITAL in orb.ts/vwapReversion.ts/pairsTrading.ts (verificato uguale nei tre, così il drawdown % è comparabile). */
export const LAB_CAPITAL_REF = 100_000;

/**
 * Sedute lab distinte chiuse richieste prima che una strategia possa ricevere capitale reale.
 * 8, scelto il 25/9/2026: con 10 (il valore iniziale) nessuna delle tre strategie l'avrebbe
 * superato quel giorno (orb/vwap a 9, pairs a 8) e il conto reale si sarebbe fermato del tutto
 * per ~2 sedute — nessuna delle tre, incluso il pairs promosso il 23/9, avrebbe passato quel
 * gate se fosse già esistito. 8 ammette da subito tutte e tre (storico dal 13-14/9) senza
 * fermare il conto reale; il gate si fa sentire solo per strategie future. Non è una soglia
 * validata statisticamente — il numero conta meno del fatto che un gate esista, da alzare
 * quando ci sarà più storia.
 */
export const MIN_TRACK_RECORD_SESSIONS = 8;

/**
 * Drawdown massimo (picco-valle, % di LAB_CAPITAL_REF) sulle ultime DRAWDOWN_LOOKBACK_SESSIONS
 * sedute lab, oltre il quale la strategia esce dall'allocazione reale finché non rientra sotto
 * soglia. Sostituisce la decisione discrezionale presa questa settimana su ORB con una regola
 * verificabile, applicata a tutte allo stesso modo. Soglia indicativa (nessun backtest l'ha
 * tarata): tenerla larga finché non c'è più storia per calibrarla senza overfitting.
 */
export const MAX_DRAWDOWN_PCT = 5.0;
export const DRAWDOWN_LOOKBACK_SESSIONS = 20;

export interface StrategyEligibility {
  strategyId: string;
  eligible: boolean;
  reason: string;
  sessionsAvailable: number;
  drawdownPct: number;
}

/**
 * Storico e drawdown recente di ogni strategia, dal lab, su sedute *precedenti* beforeDateIso
 * (mai la seduta in corso, ancora aperta — stesso principio di computeRanking in debrief.ts).
 */
export async function computeEligibility(beforeDateIso: string): Promise<StrategyEligibility[]> {
  const out: StrategyEligibility[] = [];
  for (const strategyId of STRATEGY_IDS) {
    const rows = (await db()`
      SELECT (exit_time AT TIME ZONE 'UTC')::date AS d, sum(realized_pnl)::float8 AS net
      FROM lab_positions
      WHERE status = 'closed' AND strategy_id = ${strategyId}
        AND (exit_time AT TIME ZONE 'UTC')::date < ${beforeDateIso}::date
      GROUP BY 1
      ORDER BY 1 ASC
    `) as unknown as { d: string; net: number }[];

    const sessionsAvailable = rows.length;

    // Drawdown picco-valle sulla curva cumulata delle ultime DRAWDOWN_LOOKBACK_SESSIONS sedute.
    const recent = rows.slice(-DRAWDOWN_LOOKBACK_SESSIONS);
    let cumulative = 0;
    let peak = 0;
    let maxDrawdownDollars = 0;
    for (const row of recent) {
      cumulative += row.net;
      peak = Math.max(peak, cumulative);
      maxDrawdownDollars = Math.max(maxDrawdownDollars, peak - cumulative);
    }
    const drawdownPct = (maxDrawdownDollars / LAB_CAPITAL_REF) * 100;

    let eligible = true;
    let reason = "ammessa";
    if (sessionsAvailable < MIN_TRACK_RECORD_SESSIONS) {
      eligible = false;
      reason = `storico insufficiente (${sessionsAvailable}/${MIN_TRACK_RECORD_SESSIONS} sedute lab)`;
    } else if (drawdownPct > MAX_DRAWDOWN_PCT) {
      eligible = false;
      reason = `drawdown recente ${drawdownPct.toFixed(1)}% oltre la soglia ${MAX_DRAWDOWN_PCT}%`;
    }

    out.push({ strategyId, eligible, reason, sessionsAvailable, drawdownPct });
  }
  return out;
}

/**
 * Peso di capitale reale per strategia: equal-weight tra le sole ammesse, 0 per le escluse.
 * Deliberatamente il più semplice possibile — con meno di due settimane di dati reali, un peso
 * "più intelligente" (per Sharpe, per volatilità) sarebbe un altro parametro tarato sul rumore
 * invece che su un vantaggio misurato. Se nessuna è ammessa, tutti i pesi sono 0 (niente nuovi
 * ingressi reali finché almeno una strategia non supera i gate — le uscite restano gestite).
 */
export function computeWeights(eligibility: StrategyEligibility[]): Record<string, number> {
  const eligibleIds = eligibility.filter((e) => e.eligible).map((e) => e.strategyId);
  const weights: Record<string, number> = {};
  for (const e of eligibility) weights[e.strategyId] = 0;
  for (const id of eligibleIds) weights[id] = 1 / eligibleIds.length;
  return weights;
}

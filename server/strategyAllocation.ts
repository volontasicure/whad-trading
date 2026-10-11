// Allocazione del capitale reale tra le strategie, dal 25/9/2026 — sostituisce lo schema
// "vincitore prende tutto" (un'unica PROPOSED_STRATEGY_ID, decisa da server/debrief.ts e
// finora "sempre pairs" dal 23/9). Motivo del cambio: con meno di due settimane di storia
// reale, dare il 100% del capitale a una sola strategia amplifica sull'intero conto il rumore
// di quella singola strategia (vedi ORB: -825 su NKE il 22/9, -1.154 nel lab il 24/9) — un
// problema di costruzione del portafoglio, non di segnale. Qui più strategie possono ricevere
// capitale reale insieme, ciascuna con una frazione, non un'unica proposta esclusiva.
//
// Tre gate (i primi due dal 25/9/2026, il terzo dal 29/9 — prima non esisteva nessun
// requisito prima che una strategia ricevesse capitale reale, oltre alla classifica del
// giorno):
// 1. Storico minimo in paper (lab) prima di poter ricevere capitale reale — "periodo di prova".
// 2. Uno stop automatico per singola strategia sul drawdown recente (picco-valle).
// 3. Media mobile corta (ultime 5 sedute) non negativa — aggiunta il 29/9/2026: il drawdown
//    picco-valle (punto 2) non intercetta un'erosione lenta e rumorosa come quella di ORB
//    (oscilla tra giorni positivi e negativi senza un vero crollo continuo, mai sopra il 5% di
//    drawdown nonostante fosse negativo quasi ogni giorno). Vedi CLAUDE.md.
//
// Il lab resta la base per queste decisioni (non real_positions): è la simulazione con più
// storia disponibile per tutte e tre le strategie fin dal 13-14/9, mentre il conto reale ha
// girato quasi sempre su una sola strategia alla volta finora.

import { db } from "./db.js";
import { LAB_NET_PNL_SQL } from "./costs.js";
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

/**
 * Strategie ammesse a ricevere capitale reale, dall'11/10/2026. Prima l'ammissione era un
 * insieme di gate sul rendimento recente (media a 5 sedute dal 29/9, a 20 dall'11/10) applicati
 * a tutte e tre; la validazione su 9 finestre indipendenti da ~100 sedute (~890 sedute, marzo
 * 2023 → ottobre 2026, netto di costi, scripts/multiwindow-ab.mjs) ha mostrato che era la
 * struttura sbagliata:
 *  - pairs: positivo in 9/9 finestre (+25.061$ totale, lab 100k$);
 *  - VWAP: −8.732$ (soglia 2,5%; −39.387$ a 1,2%), negativo in 5/9;
 *  - ORB: −80.899$, negativa in 9/9.
 * Allocare in modo equal-weight alle "ammesse" dai gate dimezzava il capitale del pairs per darne
 * metà a strategie senza edge: gate attuale +3.758$ contro +22.646$ per "solo pairs", peggio in
 * 9/9 finestre. E applicare le medie a 5/20 sedute al PAIRS stesso fa perdere soldi (20.832$
 * contro 25.061$ senza, 159 sedute in cassa): fa pochi trade e il suo P&L non ha memoria, dopo
 * uno stop le medie restano negative per settimane proprio mentre il segnale si riprende. Il
 * drawdown picco-valle non è mai scattato sul pairs in 892 sedute: resta come interruttore.
 * Le altre strategie continuano a girare nel lab per osservazione; per riammetterne una serve
 * un'evidenza netta di costi su più finestre indipendenti, non una settimana buona.
 */
export const REAL_CAPITAL_STRATEGIES: readonly string[] = ["pairs"];

/**
 * Orizzonti delle medie diagnostiche `recentAvgNet` / `longAvgNet` (mostrate in UI/debrief).
 * Non sono più gate: vedi REAL_CAPITAL_STRATEGIES. Storia: media a 5 sedute dal 29/9/2026
 * (tarata sui dati di quel giorno), media a 20 dall'11/10 — quest'ultima aveva migliorato il gate
 * a 5 in 7/9 finestre (+3.758$ contro +77$) ma restava ben sotto "solo pairs".
 */
export const RECENT_AVG_LOOKBACK_SESSIONS = 5;
export const LONG_AVG_LOOKBACK_SESSIONS = 20;

export interface StrategyEligibility {
  strategyId: string;
  eligible: boolean;
  reason: string;
  sessionsAvailable: number;
  drawdownPct: number;
  recentAvgNet: number;
  /** Media del netto sulle ultime LONG_AVG_LOOKBACK_SESSIONS sedute (o su quelle disponibili, se meno). */
  longAvgNet: number;
}

/**
 * Storico e drawdown recente di ogni strategia, dal lab, su sedute *precedenti* beforeDateIso
 * (mai la seduta in corso, ancora aperta — stesso principio di computeRanking in debrief.ts).
 */
export async function computeEligibility(beforeDateIso: string): Promise<StrategyEligibility[]> {
  const out: StrategyEligibility[] = [];
  for (const strategyId of STRATEGY_IDS) {
    // Netto di costi di esecuzione (server/costs.ts): un gate sul lordo ammetterebbe strategie ad
    // alto turnover (VWAP) il cui edge è consumato dallo slippage sul conto reale.
    const rows = (await db().query(
      `SELECT (exit_time AT TIME ZONE 'UTC')::date AS d, sum(${LAB_NET_PNL_SQL})::float8 AS net
       FROM lab_positions
       WHERE status = 'closed' AND strategy_id = $1
         AND (exit_time AT TIME ZONE 'UTC')::date < $2::date
       GROUP BY 1
       ORDER BY 1 ASC`,
      [strategyId, beforeDateIso]
    )) as unknown as { d: string; net: number }[];

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

    // Medie diagnostiche (non più gate, vedi REAL_CAPITAL_STRATEGIES): ultime
    // RECENT_AVG_LOOKBACK_SESSIONS sedute, indipendenti dalla finestra del drawdown sopra.
    const recentShort = rows.slice(-RECENT_AVG_LOOKBACK_SESSIONS);
    const recentAvgNet = recentShort.length > 0 ? recentShort.reduce((s, r) => s + r.net, 0) / recentShort.length : 0;

    // Media lunga, ultime LONG_AVG_LOOKBACK_SESSIONS sedute.
    const recentLong = rows.slice(-LONG_AVG_LOOKBACK_SESSIONS);
    const longAvgNet = recentLong.length > 0 ? recentLong.reduce((s, r) => s + r.net, 0) / recentLong.length : 0;

    let eligible = true;
    let reason = "ammessa";
    if (!REAL_CAPITAL_STRATEGIES.includes(strategyId)) {
      eligible = false;
      reason = `fuori dal capitale reale: nessun edge netto di costi sui backtest (resta nel lab per osservazione)`;
    } else if (sessionsAvailable < MIN_TRACK_RECORD_SESSIONS) {
      eligible = false;
      reason = `storico insufficiente (${sessionsAvailable}/${MIN_TRACK_RECORD_SESSIONS} sedute lab)`;
    } else if (drawdownPct > MAX_DRAWDOWN_PCT) {
      eligible = false;
      reason = `drawdown recente ${drawdownPct.toFixed(1)}% oltre la soglia ${MAX_DRAWDOWN_PCT}%`;
    }

    out.push({ strategyId, eligible, reason, sessionsAvailable, drawdownPct, recentAvgNet, longAvgNet });
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

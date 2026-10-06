// Controlli di coerenza tra conto reale e laboratori — parte con I/O (database + Alpaca). La
// logica di decisione è pura e sta in server/realVsLab.ts.
//
// Usato da due chiamanti, stesso codice:
//   - api/cron/tick.ts via server/consistencyRunner.ts (primario: il tick arriva ogni 5 minuti da
//     cron-job.org, mentre gli schedule di GitHub Actions girano solo 1-3 volte al giorno);
//   - scripts/monitor.ts (GitHub Actions, resta come controllo aggiuntivo anche a mercato chiuso).
//
// Quattro controlli, nessuno tocca segnali o parametri di strategia:
//   1. riconciliazione broker ↔ real_positions;
//   2. trade reali chiusi oggi senza un gemello nel lab;
//   3. scostamento del realizzato di oggi, reale contro lab scalati per capitale e peso;
//   4. scostamento CUMULATIVO sulle ultime sedute, per strategia (coglie il divario che si
//      accumula poco alla volta, sotto la soglia giornaliera).

import { alpacaFetch } from "./alpaca.js";
import { db } from "./db.js";
import { fetchMarketSession } from "./marketHours.js";
import { STRATEGY_ID as ORB_STRATEGY_ID } from "./orb.js";
import { STRATEGY_ID as VWAP_STRATEGY_ID } from "./vwapReversion.js";
import { STRATEGY_ID as PAIRS_STRATEGY_ID } from "./pairsTrading.js";
import { computeEligibility, computeWeights, LAB_CAPITAL_REF } from "./strategyAllocation.js";
import {
  CUMULATIVE_SESSIONS,
  MIN_CUMULATIVE_SESSIONS,
  computeCumulativeGap,
  computeDeviation,
  findUnmatchedRealTrades,
  reconcilePositions,
  type Anomaly,
  type CumulativeRow,
  type RealClosedTrade,
  type Side,
  type TradeKey,
} from "./realVsLab.js";

const STRATEGY_IDS = [ORB_STRATEGY_ID, VWAP_STRATEGY_ID, PAIRS_STRATEGY_ID];
const STRATEGY_LABELS: Record<string, string> = {
  [ORB_STRATEGY_ID]: "ORB",
  [VWAP_STRATEGY_ID]: "VWAP reversion",
  [PAIRS_STRATEGY_ID]: "Pairs trading",
};

interface AlpacaPositionRow {
  symbol: string;
  qty: string;
  side: "long" | "short";
}

interface AlpacaAccountRow {
  equity: string;
}

const fmt = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(0)}$`;

/** Il client Neon restituisce una thenable con tipi generici: la query tipizzata va forzata qui, in un punto solo. */
async function q<T>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await db().query(text, params)) as unknown as T[];
}

/** Iniettabile solo per i test (un Postgres in memoria al posto di Neon). */
export type QueryFn = <T>(text: string, params?: unknown[]) => Promise<T[]>;

export interface ConsistencyResult {
  anomalies: Anomaly[];
  /** Righe di riepilogo, sempre presenti anche senza anomalie. */
  lines: string[];
}

export async function runConsistencyChecks(opts: { tradingDate: string; sessionOpenUtc?: string }): Promise<ConsistencyResult> {
  const anomalies: Anomaly[] = [];
  const lines: string[] = [];

  const sessionOpenUtc = opts.sessionOpenUtc ?? (await fetchMarketSession(opts.tradingDate))?.openUtc;

  // --- 1. Riconciliazione broker ↔ real_positions ---
  const [brokerRows, dbOpenRows] = await Promise.all([
    alpacaFetch<AlpacaPositionRow[]>("/v2/positions"),
    q<{ symbol: string; side: Side; qty: number }>(`SELECT symbol, side, qty::float8 AS qty FROM real_positions WHERE status = 'open'`),
  ]);
  const broker = brokerRows.map((p) => {
    const abs = Math.abs(Number(p.qty));
    return { symbol: p.symbol, signedQty: p.side === "short" ? -abs : abs };
  });
  const mismatches = reconcilePositions(broker, dbOpenRows);
  for (const m of mismatches) {
    anomalies.push({
      key: `recon:${m.symbol}`,
      summary: `[REALE] ${m.symbol}: sul broker ${m.brokerQty} azioni, nel DB ${m.dbQty}`,
      suggestion:
        m.dbQty === 0
          ? "Posizione presente su Alpaca ma non registrata in real_positions (stesso schema della doppia chiusura di BA del 30/9): nessuna regola la gestisce. Verifica gli ordini di oggi su quel simbolo e chiudila/registrala a mano."
          : m.brokerQty === 0
            ? "Il DB la considera aperta ma sul broker non c'è più: chiusura (bracket, EOD o manuale) non registrata. Recupera il fill da /v2/orders?status=closed e aggiorna real_positions, altrimenti il realized non viene contato."
            : "Quantità diversa tra broker e DB: probabile fill parziale o doppio ordine. Controlla gli ordini di oggi su quel simbolo.",
    });
  }
  lines.push(`Riconciliazione broker↔DB: ${mismatches.length === 0 ? "OK" : `${mismatches.length} differenze`} (${broker.length} posizioni sul broker)`);

  if (!sessionOpenUtc) return { anomalies, lines };

  // --- 2 e 3. Trade senza gemello nel lab; scostamento del realizzato di oggi ---
  const [realClosedRows, labTouchedRows, labRealizedRows, account, eligibility] = await Promise.all([
    q<{ strategy_id: string; symbol: string; side: Side; realized_pnl: number | null; exit_reason: string | null }>(
      `SELECT strategy_id, symbol, side, realized_pnl::float8 AS realized_pnl, exit_reason
       FROM real_positions WHERE status = 'closed' AND exit_time >= $1`,
      [sessionOpenUtc]
    ),
    q<{ strategy_id: string; symbol: string; side: Side }>(
      `SELECT DISTINCT strategy_id, symbol, side FROM lab_positions
       WHERE status = 'open' OR exit_time >= $1 OR entry_time >= $1`,
      [sessionOpenUtc]
    ),
    q<{ strategy_id: string; pnl: number }>(
      `SELECT strategy_id, coalesce(sum(realized_pnl), 0)::float8 AS pnl
       FROM lab_positions WHERE status = 'closed' AND exit_time >= $1 GROUP BY strategy_id`,
      [sessionOpenUtc]
    ),
    alpacaFetch<AlpacaAccountRow>("/v2/account"),
    computeEligibility(opts.tradingDate),
  ]);
  const equity = Number(account.equity);

  const realClosed: RealClosedTrade[] = realClosedRows.map((r) => ({
    strategyId: r.strategy_id,
    symbol: r.symbol,
    side: r.side,
    realizedPnl: r.realized_pnl ?? 0,
    exitReason: r.exit_reason,
  }));
  const labTouched: TradeKey[] = labTouchedRows.map((r) => ({ strategyId: r.strategy_id, symbol: r.symbol, side: r.side }));
  for (const t of findUnmatchedRealTrades(realClosed, labTouched)) {
    anomalies.push({
      key: `unmatched:${t.strategyId}:${t.symbol}:${t.side}`,
      summary: `[REALE] Trade ${t.strategyId} ${t.side} ${t.symbol} chiuso oggi (${fmt(t.realizedPnl)}, uscita: ${t.exitReason ?? "n/d"}) senza nessuna posizione corrispondente nel lab`,
      suggestion:
        "Il conto reale ha operato su qualcosa che la strategia nel lab non ha mai deciso: controlla in server/realExecution.ts come è nato l'ingresso (posizione ereditata da un giorno precedente? riconciliazione bracket? ordine duplicato?).",
    });
  }

  const weights = computeWeights(eligibility);
  const labByStrategy = new Map(labRealizedRows.map((r) => [r.strategy_id, r.pnl]));
  const realByStrategy = new Map<string, number>();
  for (const t of realClosed) realByStrategy.set(t.strategyId, (realByStrategy.get(t.strategyId) ?? 0) + t.realizedPnl);

  const deviation = computeDeviation(
    STRATEGY_IDS.map((id) => ({
      strategyId: id,
      labRealized: labByStrategy.get(id) ?? 0,
      realRealized: realByStrategy.get(id) ?? 0,
      weight: weights[id] ?? 0,
    })),
    equity,
    LAB_CAPITAL_REF
  );
  const detail = deviation.byStrategy
    .filter((r) => Math.abs(r.expected) >= 1 || Math.abs(r.actual) >= 1)
    .map((r) => `${STRATEGY_LABELS[r.strategyId]} atteso ${fmt(r.expected)} / reale ${fmt(r.actual)}`)
    .join("; ");
  const dailySummary = `Reale vs lab, realizzato oggi: atteso ${fmt(deviation.expected)}, reale ${fmt(deviation.actual)}, scostamento ${fmt(deviation.gap)} (soglia ±${deviation.threshold.toFixed(0)}$)${detail ? ` — ${detail}` : ""}`;
  lines.push(dailySummary);
  if (deviation.breached) {
    anomalies.push({
      key: "deviation:daily",
      summary: `[REALE] ${dailySummary}`,
      suggestion:
        "Il conto reale non sta replicando i lab ammessi oggi. Le cause viste finora sono tutte di esecuzione, non di strategia: size diversa dal previsto, ordini doppi, chiusure non registrate, posizioni ereditate da strategie a peso zero. Guarda prima le altre anomalie [REALE], poi tick_log e gli ordini Alpaca di oggi.",
    });
  }

  // --- 4. Scostamento cumulativo sulle ultime sedute, per strategia ---
  const cumulative = await computeCumulativeFromDb(opts.tradingDate, equity);
  if (cumulative.kind === "skipped") {
    lines.push(`Reale vs lab, cumulativo: ${cumulative.reason}`);
  } else {
    const c = cumulative.result;
    const byStrat = c.byStrategy
      .filter((r) => Math.abs(r.expected) >= 1 || Math.abs(r.actual) >= 1)
      .map((r) => `${STRATEGY_LABELS[r.strategyId]} atteso ${fmt(r.expected)} / reale ${fmt(r.actual)}`)
      .join("; ");
    const cumSummary = `Reale vs lab, ultime ${c.sessions} sedute: atteso ${fmt(c.expected)}, reale ${fmt(c.actual)}, scostamento ${fmt(c.gap)} (allarme sotto −${c.threshold.toFixed(0)}$, soglia di partenza non calibrata)${byStrat ? ` — ${byStrat}` : ""}`;
    lines.push(cumSummary);
    if (c.breached) {
      anomalies.push({
        key: "deviation:cumulative",
        summary: `[REALE] ${cumSummary}`,
        suggestion:
          "Il reale rende sistematicamente meno di quanto i lab ammessi implicano, con uno scarto che si accumula sotto la soglia giornaliera. Guarda per quale strategia lo scostamento è più grande (riepilogo sopra) e confronta ingressi e uscite reali con quelli del lab: filtro shortable, sizing per convinzione, ingressi dopo la conferma del mattino.",
      });
    }
  }

  return { anomalies, lines };
}

export type CumulativeOutcome = { kind: "ok"; result: ReturnType<typeof computeCumulativeGap> } | { kind: "skipped"; reason: string };

/**
 * Per le ultime CUMULATIVE_SESSIONS sedute registrate in `sessions` (precedenti a oggi), prende le
 * strategie ammesse quel giorno (il campo strategy_id le elenca unite da "+", peso uguale tra
 * loro come in computeWeights) e il realizzato per strategia di lab e reale. Le sedute senza riga
 * in `sessions` (es. 25-29/9, quando la chiusura di fine giornata non scattava) non entrano.
 */
export async function computeCumulativeFromDb(tradingDate: string, equity: number, query: QueryFn = q): Promise<CumulativeOutcome> {
  const sessionRows = await query<{ d: string; strategy_id: string }>(
    `SELECT to_char(trading_date, 'YYYY-MM-DD') AS d, strategy_id FROM sessions
     WHERE trading_date < $1::date ORDER BY trading_date DESC LIMIT ${CUMULATIVE_SESSIONS}`,
    [tradingDate]
  );
  if (sessionRows.length < MIN_CUMULATIVE_SESSIONS) {
    return { kind: "skipped", reason: `saltato (${sessionRows.length}/${MIN_CUMULATIVE_SESSIONS} sedute registrate)` };
  }
  const dates = sessionRows.map((r) => r.d).sort();
  const first = dates[0];
  const last = dates[dates.length - 1];

  // Intervallo di date invece di un array: evita di dipendere da come il driver serializza gli array.
  const [labRows, realRows] = await Promise.all([
    query<{ d: string; strategy_id: string; pnl: number }>(
      `SELECT to_char((exit_time AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS d, strategy_id, sum(realized_pnl)::float8 AS pnl
       FROM lab_positions WHERE status = 'closed'
         AND (exit_time AT TIME ZONE 'UTC')::date >= $1::date AND (exit_time AT TIME ZONE 'UTC')::date <= $2::date
       GROUP BY 1, 2`,
      [first, last]
    ),
    query<{ d: string; strategy_id: string; pnl: number }>(
      `SELECT to_char((exit_time AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS d, strategy_id, sum(realized_pnl)::float8 AS pnl
       FROM real_positions WHERE status = 'closed'
         AND (exit_time AT TIME ZONE 'UTC')::date >= $1::date AND (exit_time AT TIME ZONE 'UTC')::date <= $2::date
       GROUP BY 1, 2`,
      [first, last]
    ),
  ]);
  const lab = new Map(labRows.map((r) => [`${r.d}|${r.strategy_id}`, r.pnl]));
  const real = new Map(realRows.map((r) => [`${r.d}|${r.strategy_id}`, r.pnl]));

  const rows: CumulativeRow[] = [];
  for (const s of sessionRows) {
    const admitted = s.strategy_id.split("+");
    for (const id of STRATEGY_IDS) {
      rows.push({
        date: s.d,
        strategyId: id,
        labRealized: lab.get(`${s.d}|${id}`) ?? 0,
        realRealized: real.get(`${s.d}|${id}`) ?? 0,
        weight: admitted.includes(id) ? 1 / admitted.length : 0,
      });
    }
  }
  return { kind: "ok", result: computeCumulativeGap(rows, equity, LAB_CAPITAL_REF) };
}

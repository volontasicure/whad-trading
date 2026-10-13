// Revisione di fine seduta (livello 1 del processo di miglioramento): per ogni trade chiuso calcola
// i dati derivati (server/tradeReview.ts, logica pura), li salva in `trade_review` e invia il
// rapporto serale. NON propone né applica modifiche alla strategia: misura e segnala.
//
// Come viene eseguita: dal tick (api/cron/tick.ts), nel ramo "mercato chiuso", cioè dallo stesso
// scheduler affidabile (cron-job.org, ogni 5 minuti) che gira anche a mercato chiuso. Non da un
// cron dedicato: gli schedule di GitHub e di Vercel qui sono già risultati inaffidabili (vedi
// CLAUDE.md, "eod-close.yml si è degradato"), e un task della sessione locale parte solo con l'app aperta.
//
// Garanzie:
//   - gira dopo la chiusura, mai durante la seduta, quindi non può toccare l'esecuzione;
//   - idempotente: stato in lab_state (strategy_id "review"), trade_review con chiave naturale;
//   - a fasi (A: calcolo e salvataggio, B: rapporto e mail) e con un massimo di tentativi, così un
//     problema persistente non si ripete per tutta la notte né può far scadere un tick a lungo;
//   - la mail richiede RESEND_API_KEY nell'ambiente Vercel; se manca il rapporto resta comunque
//     salvato in lab_state e la causa è nella nota del tick.

import { alpacaFetch } from "./alpaca.js";
import { db } from "./db.js";
import { sendAlertEmail } from "./alertEmail.js";
import { runConsistencyChecks } from "./consistencyCheck.js";
import { fetchMarketSession } from "./marketHours.js";
import {
  analyzeGap,
  buildDailyReport,
  buildFlags,
  computeExcursion,
  groupUnits,
  matchTwins,
  nearestZ,
  orbBreakout,
  vwapDistancePct,
  type Bar,
  type ClosedRow,
  type CumulativeView,
  type OpenPairView,
  type ReportInput,
  type ReviewedTrade,
  type SkippedView,
  type TickHealth,
  type TradeUnit,
} from "./tradeReview.js";

const STATE_STRATEGY_ID = "review";
const STATE_KEY = "daily";
const MAX_ATTEMPTS = 4;
const PHASE_TIMEOUT_MS = 20_000;
/** Dopo la fase A si prosegue con la B nello stesso tick solo se si è ancora ben dentro un budget prudente. */
const CONTINUE_IF_ELAPSED_UNDER_MS = 5_000;
const FIVE_MIN_MS = 5 * 60_000;

async function q<T>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await db().query(text, params)) as unknown as T[];
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what}: timeout dopo ${ms / 1000}s`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

const iso = (x: unknown): string => new Date(x as string | number | Date).toISOString();

interface PositionRow {
  id: number;
  strategy_id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  entry_price: number;
  exit_price: number;
  entry_time: unknown;
  exit_time: unknown;
  realized_pnl: number | null;
  exit_reason: string | null;
  pair_key: string | null;
  conviction?: number | null;
}

function toClosedRow(r: PositionRow, source: "real" | "lab"): ClosedRow {
  return {
    id: r.id,
    source,
    strategyId: r.strategy_id,
    symbol: r.symbol,
    side: r.side,
    qty: Number(r.qty),
    entryPrice: Number(r.entry_price),
    exitPrice: Number(r.exit_price),
    entryTime: iso(r.entry_time),
    exitTime: iso(r.exit_time),
    realizedPnl: Number(r.realized_pnl ?? 0),
    exitReason: r.exit_reason,
    pairKey: r.pair_key,
    conviction: r.conviction != null ? Number(r.conviction) : null,
  };
}

interface BarRow {
  symbol: string;
  bar_time: unknown;
  h: number;
  l: number;
  c: number;
  vwap: number;
}

async function fetchBars(symbols: string[], fromMs: number, toMs: number): Promise<Record<string, Bar[]>> {
  const rows = await q<BarRow>(
    `SELECT symbol, bar_time, high::float8 AS h, low::float8 AS l, close::float8 AS c, vwap::float8 AS vwap
     FROM session_bars WHERE symbol = ANY($1::text[]) AND bar_time >= $2 AND bar_time <= $3 ORDER BY bar_time`,
    [symbols, new Date(fromMs).toISOString(), new Date(toMs).toISOString()]
  );
  const out: Record<string, Bar[]> = {};
  for (const r of rows) (out[r.symbol] ??= []).push({ t: new Date(r.bar_time as string).getTime(), h: r.h, l: r.l, c: r.c, vwap: r.vwap });
  return out;
}

async function fetchZLog(pairKeyVal: string, windows: [number, number][]): Promise<{ t: number; z: number }[]> {
  const conds = windows.map((_, i) => `(ts >= $${2 + i * 2} AND ts <= $${3 + i * 2})`).join(" OR ");
  const params: unknown[] = [pairKeyVal];
  for (const [a, b] of windows) params.push(new Date(a).toISOString(), new Date(b).toISOString());
  const rows = await q<{ ts: unknown; z: number }>(`SELECT ts, z::float8 AS z FROM pairs_zscore_log WHERE pair_key = $1 AND (${conds})`, params);
  return rows.map((r) => ({ t: new Date(r.ts as string).getTime(), z: r.z }));
}

async function runChunked<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

/**
 * Trasforma le righe chiuse nella finestra in trade COMPLETI. Le gambe di una coppia possono chiudersi
 * in giorni diversi (gamba orfana, doppia chiusura): il trade esiste solo quando tutte le gambe sono
 * chiuse e appartiene alla seduta dell'ultima chiusura, col P&L di tutte le gambe. Senza questo,
 * una gamba chiusa da sola veniva valutata come un trade a sé e poi sovrascritta dalla gamba gemella
 * (trovato sul JPM/BAC e sul TXN/AVGO: +140$ spariti dal totale del pairs).
 */
async function completeUnits(table: "real_positions" | "lab_positions", windowRows: PositionRow[], source: "real" | "lab", lo: string, hi: string): Promise<TradeUnit[]> {
  const pairKeys = [...new Set(windowRows.filter((r) => r.pair_key).map((r) => r.pair_key!))];
  let closed = windowRows;
  const incomplete = new Set<string>();
  if (pairKeys.length > 0) {
    const conviction = table === "real_positions" ? ", conviction::float8 AS conviction" : "";
    const all = await q<PositionRow & { status: string }>(
      `SELECT id, strategy_id, symbol, side, qty::float8 AS qty, entry_price::float8 AS entry_price, exit_price::float8 AS exit_price,
              entry_time, exit_time, realized_pnl::float8 AS realized_pnl, exit_reason, pair_key, status${conviction}
       FROM ${table} WHERE pair_key = ANY($1::text[])`,
      [pairKeys]
    );
    const singles = windowRows.filter((r) => !r.pair_key);
    closed = [...singles, ...all.filter((r) => r.status === "closed")];
    for (const r of all) if (r.status !== "closed") incomplete.add(`${r.pair_key}|${iso(r.entry_time)}`);
  }
  const loMs = Date.parse(lo);
  const hiMs = Date.parse(hi);
  return groupUnits(closed.map((r) => toClosedRow(r, source))).filter((u) => {
    if (u.legs[0].pairKey && incomplete.has(`${u.legs[0].pairKey}|${u.legs[0].entryTime}`)) return false;
    const exitMs = Date.parse(u.exitTime);
    return exitMs >= loMs && exitMs <= hiMs;
  });
}

/**
 * Fase A: legge i trade chiusi nella finestra della seduta, calcola le metriche derivate, abbina i
 * gemelli reale↔lab e salva in trade_review. Riutilizzabile per lo storico (scripts/backfill-trade-review.ts).
 */
export async function reviewSession(opts: { date: string; openUtc: string; closeUtc: string }): Promise<{ real: ReviewedTrade[]; lab: ReviewedTrade[] }> {
  const lo = new Date(Date.parse(opts.openUtc) - FIVE_MIN_MS).toISOString();
  const hi = new Date(Date.parse(opts.closeUtc) + 60 * 60_000).toISOString();

  const [realRows, labRows] = await Promise.all([
    q<PositionRow>(
      `SELECT id, strategy_id, symbol, side, qty::float8 AS qty, entry_price::float8 AS entry_price, exit_price::float8 AS exit_price,
              entry_time, exit_time, realized_pnl::float8 AS realized_pnl, exit_reason, pair_key, conviction::float8 AS conviction
       FROM real_positions WHERE status = 'closed' AND exit_time >= $1 AND exit_time <= $2`,
      [lo, hi]
    ),
    q<PositionRow>(
      `SELECT id, strategy_id, symbol, side, qty::float8 AS qty, entry_price::float8 AS entry_price, exit_price::float8 AS exit_price,
              entry_time, exit_time, realized_pnl::float8 AS realized_pnl, exit_reason, pair_key
       FROM lab_positions WHERE status = 'closed' AND exit_time >= $1 AND exit_time <= $2`,
      [lo, hi]
    ),
  ]);

  const realUnits = await completeUnits("real_positions", realRows, "real", lo, hi);
  const labUnits = await completeUnits("lab_positions", labRows, "lab", lo, hi);
  const twins = matchTwins(realUnits, labUnits);

  // Posizioni lab (aperte o chiuse) la cui vita si sovrappone a quella di un trade reale: servono a
  // distinguere "il lab teneva la stessa posizione, entrata in un altro momento" (non un'anomalia)
  // da "il lab non l'ha mai decisa". Una sola query, solo se ci sono trade reali.
  const minRealEntry = realUnits.length ? Math.min(...realUnits.map((u) => Date.parse(u.entryTime))) : Date.parse(hi);
  const labLife = realUnits.length
    ? await q<{ strategy_id: string; symbol: string; side: string; entry_time: unknown; exit_time: unknown }>(
        `SELECT strategy_id, symbol, side, entry_time, exit_time FROM lab_positions
         WHERE entry_time <= $1 AND (exit_time IS NULL OR exit_time >= $2)`,
        [hi, new Date(minRealEntry).toISOString()]
      )
    : [];
  const labOverlaps = (u: TradeUnit): boolean => {
    const rs = Date.parse(u.entryTime);
    const re = Date.parse(u.exitTime);
    return u.legs.every((leg) =>
      labLife.some(
        (r) =>
          r.strategy_id === u.strategyId &&
          r.symbol === leg.symbol &&
          r.side === leg.side &&
          new Date(r.entry_time as string).getTime() <= re &&
          (r.exit_time == null || new Date(r.exit_time as string).getTime() >= rs)
      )
    );
  };

  const orbRangeCache = new Map<string, Record<string, { high: number; low: number }> | null>();
  const getOrbRanges = async (tradingDate: string) => {
    if (!orbRangeCache.has(tradingDate)) {
      const rows = await q<{ value: Record<string, { high: number; low: number }> }>(
        `SELECT value FROM lab_state WHERE strategy_id = 'orb' AND trading_date = $1 AND key = 'opening_range'`,
        [tradingDate]
      );
      orbRangeCache.set(tradingDate, rows[0]?.value ?? null);
    }
    return orbRangeCache.get(tradingDate)!;
  };

  const review = async (u: TradeUnit, twin: TradeUnit | null | undefined, isReal: boolean): Promise<ReviewedTrade> => {
    const entryMs = Date.parse(u.entryTime);
    const exitMs = Date.parse(u.exitTime);
    const symbols = [...new Set(u.legs.map((l) => l.symbol))];
    const bars = await fetchBars(symbols, entryMs - FIVE_MIN_MS, exitMs);
    const { mae, mfe } = computeExcursion(u, bars);

    let entrySignal: number | null = null;
    let exitSignal: number | null = null;
    if (u.side === "PAIR") {
      const log = await fetchZLog(u.subject, [
        [entryMs - 4 * 60_000, entryMs + 4 * 60_000],
        [exitMs - 4 * 60_000, exitMs + 4 * 60_000],
      ]);
      entrySignal = nearestZ(log, entryMs);
      exitSignal = nearestZ(log, exitMs);
    } else if (u.strategyId === "vwap_reversion") {
      entrySignal = vwapDistancePct(u.legs[0].entryPrice, bars[u.legs[0].symbol] ?? [], entryMs);
    } else if (u.strategyId === "orb") {
      const ranges = await getOrbRanges(u.entryTime.slice(0, 10));
      const range = ranges?.[u.legs[0].symbol];
      if (range) entrySignal = orbBreakout(u.legs[0].entryPrice, u.legs[0].side, range);
    }

    // I trade reali chiusi a mano (pulizie una tantum) non hanno un gemello e non vanno segnalati.
    const manual = (u.exitReason ?? "").startsWith("manual");
    const gap = isReal && !manual ? analyzeGap(u, twin ?? null, labOverlaps(u)) : null;
    return { ...u, mae, mfe, entrySignal, exitSignal, twin: gap };
  };

  const realReviewed = await runChunked(realUnits, 6, (u) => {
    const idx = realUnits.indexOf(u);
    const li = twins.get(idx);
    return review(u, li != null ? labUnits[li] : null, true);
  });
  const labReviewed = await runChunked(labUnits, 6, (u) => review(u, null, false));

  for (const t of [...realReviewed, ...labReviewed]) {
    await db()`
      INSERT INTO trade_review
        (trading_date, source, strategy_id, subject, side, entry_time, exit_time, hold_minutes, notional, gross_pnl, cost_est, net_pnl,
         exit_reason, mae, mfe, entry_signal, exit_signal, conviction, twin_pnl, return_gap_pct, entry_slip_pct, exit_slip_pct, gap_cause)
      VALUES
        (${opts.date}, ${t.source}, ${t.strategyId}, ${t.subject}, ${t.side}, ${t.entryTime}, ${t.exitTime}, ${t.holdMinutes}, ${t.notional},
         ${t.grossPnl}, ${t.costEst}, ${t.netPnl}, ${t.exitReason}, ${t.mae}, ${t.mfe}, ${t.entrySignal}, ${t.exitSignal}, ${t.conviction},
         ${t.twin?.twinGross ?? null}, ${t.twin?.returnGapPct ?? null}, ${t.twin?.entrySlipPct ?? null}, ${t.twin?.exitSlipPct ?? null}, ${t.twin?.cause ?? null})
      ON CONFLICT (source, strategy_id, subject, entry_time) DO UPDATE SET
        trading_date = EXCLUDED.trading_date, exit_time = EXCLUDED.exit_time, hold_minutes = EXCLUDED.hold_minutes,
        notional = EXCLUDED.notional, gross_pnl = EXCLUDED.gross_pnl, cost_est = EXCLUDED.cost_est, net_pnl = EXCLUDED.net_pnl,
        exit_reason = EXCLUDED.exit_reason, mae = EXCLUDED.mae, mfe = EXCLUDED.mfe, entry_signal = EXCLUDED.entry_signal,
        exit_signal = EXCLUDED.exit_signal, conviction = EXCLUDED.conviction, twin_pnl = EXCLUDED.twin_pnl,
        return_gap_pct = EXCLUDED.return_gap_pct, entry_slip_pct = EXCLUDED.entry_slip_pct, exit_slip_pct = EXCLUDED.exit_slip_pct,
        gap_cause = EXCLUDED.gap_cause
    `;
  }
  return { real: realReviewed, lab: labReviewed };
}

// ---------------------------------------------------------------------------------------------
// Fase B: rapporto
// ---------------------------------------------------------------------------------------------

interface ReviewRow {
  source: "real" | "lab";
  strategy_id: string;
  subject: string;
  side: string;
  entry_time: unknown;
  exit_time: unknown;
  hold_minutes: number;
  notional: number;
  gross_pnl: number;
  cost_est: number;
  net_pnl: number;
  exit_reason: string | null;
  mae: number | null;
  mfe: number | null;
  entry_signal: number | null;
  exit_signal: number | null;
  conviction: number | null;
  twin_pnl: number | null;
  return_gap_pct: number | null;
  entry_slip_pct: number | null;
  exit_slip_pct: number | null;
  gap_cause: string | null;
}

function fromReviewRow(r: ReviewRow): ReviewedTrade {
  return {
    source: r.source,
    strategyId: r.strategy_id,
    subject: r.subject,
    side: r.side as ReviewedTrade["side"],
    legs: [],
    entryTime: iso(r.entry_time),
    exitTime: iso(r.exit_time),
    holdMinutes: Number(r.hold_minutes),
    notional: Number(r.notional),
    grossPnl: Number(r.gross_pnl),
    costEst: Number(r.cost_est),
    netPnl: Number(r.net_pnl),
    exitReason: r.exit_reason,
    conviction: r.conviction != null ? Number(r.conviction) : null,
    mae: r.mae != null ? Number(r.mae) : null,
    mfe: r.mfe != null ? Number(r.mfe) : null,
    entrySignal: r.entry_signal != null ? Number(r.entry_signal) : null,
    exitSignal: r.exit_signal != null ? Number(r.exit_signal) : null,
    twin: r.gap_cause
      ? {
          cause: r.gap_cause as NonNullable<ReviewedTrade["twin"]>["cause"],
          twinGross: r.twin_pnl != null ? Number(r.twin_pnl) : null,
          returnGapPct: r.return_gap_pct != null ? Number(r.return_gap_pct) : null,
          entrySlipPct: r.entry_slip_pct != null ? Number(r.entry_slip_pct) : null,
          exitSlipPct: r.exit_slip_pct != null ? Number(r.exit_slip_pct) : null,
        }
      : null,
  };
}

async function loadTickHealth(openUtc: string, closeUtc: string): Promise<TickHealth> {
  const rows = await q<{ ran_at: unknown; market_open: boolean; note: string | null }>(
    `SELECT ran_at, market_open, note FROM tick_log WHERE ran_at >= $1 AND ran_at <= $2 ORDER BY ran_at`,
    [new Date(Date.parse(openUtc) - 30 * 60_000).toISOString(), new Date(Date.parse(closeUtc) + 60 * 60_000).toISOString()]
  );
  const open = rows.filter((r) => r.market_open);
  let maxGap = 0;
  for (let i = 1; i < open.length; i++) {
    maxGap = Math.max(maxGap, (new Date(open[i].ran_at as string).getTime() - new Date(open[i - 1].ran_at as string).getTime()) / 60_000);
  }
  const errorNotes = open
    .map((r) => r.note ?? "")
    .filter((n) => /errore|STOP GIORNALIERO|\b[1-9]\d* fallit/i.test(n));
  const hhmm = (x: unknown) => iso(x).slice(11, 16);
  return {
    totalTicks: rows.length,
    openTicks: open.length,
    maxGapMin: maxGap,
    firstUtc: open.length ? hhmm(open[0].ran_at) : null,
    lastUtc: open.length ? hhmm(open[open.length - 1].ran_at) : null,
    errorNotes: [...new Set(errorNotes)],
  };
}

async function loadOpenPairs(date: string, closeUtc: string): Promise<OpenPairView[]> {
  const rows = await q<{ id: number; symbol: string; side: "LONG" | "SHORT"; qty: number; entry_price: number; entry_time: unknown; pair_key: string }>(
    `SELECT id, symbol, side, qty::float8 AS qty, entry_price::float8 AS entry_price, entry_time, pair_key
     FROM real_positions WHERE status = 'open' AND pair_key IS NOT NULL ORDER BY id`
  );
  const byKey = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!byKey.has(r.pair_key)) byKey.set(r.pair_key, []);
    byKey.get(r.pair_key)!.push(r);
  }
  const out: OpenPairView[] = [];
  for (const [key, legs] of byKey) {
    const entryMs = Math.min(...legs.map((l) => new Date(l.entry_time as string).getTime()));
    const toMs = Date.parse(closeUtc);
    const symbols = legs.map((l) => l.symbol);
    const bars = await fetchBars(symbols, entryMs - FIVE_MIN_MS, toMs);
    let unrealized: number | null = null;
    if (symbols.every((s) => (bars[s]?.length ?? 0) > 0)) {
      unrealized = legs.reduce((s, l) => {
        const last = bars[l.symbol][bars[l.symbol].length - 1].c;
        return s + l.qty * (last - l.entry_price) * (l.side === "LONG" ? 1 : -1);
      }, 0);
    }
    const pseudo: TradeUnit = {
      source: "real",
      strategyId: "pairs",
      subject: key,
      side: "PAIR",
      legs: legs.map((l) => ({
        id: l.id,
        source: "real",
        strategyId: "pairs",
        symbol: l.symbol,
        side: l.side,
        qty: l.qty,
        entryPrice: l.entry_price,
        exitPrice: l.entry_price,
        entryTime: iso(l.entry_time),
        exitTime: closeUtc,
        realizedPnl: unrealized ?? 0,
        exitReason: null,
        pairKey: key,
        conviction: null,
      })),
      entryTime: new Date(entryMs).toISOString(),
      exitTime: closeUtc,
      holdMinutes: 0,
      notional: 0,
      grossPnl: unrealized ?? 0,
      costEst: 0,
      netPnl: unrealized ?? 0,
      exitReason: null,
      conviction: null,
    };
    const { mae } = computeExcursion(pseudo, bars);
    const sessionDates = new Set<string>();
    for (const s of symbols) for (const b of bars[s] ?? []) sessionDates.add(new Date(b.t).toISOString().slice(0, 10));
    const zNow = await q<{ z: number }>(
      `SELECT z::float8 AS z FROM pairs_zscore_log WHERE pair_key = $1 AND trading_date = $2 ORDER BY ts DESC LIMIT 1`,
      [key, date]
    );
    const zLog = await fetchZLog(key, [[entryMs - 4 * 60_000, entryMs + 4 * 60_000]]);
    out.push({
      pairKey: key,
      legs: legs.map((l) => `${l.symbol} ${l.side === "LONG" ? "long" : "short"} ${l.qty}`).join(" / "),
      sessionsHeld: Math.max(1, sessionDates.size),
      unrealized,
      mae,
      entryZ: nearestZ(zLog, entryMs),
      currentZ: zNow[0]?.z ?? null,
    });
  }
  return out;
}

export async function buildReport(opts: { date: string; openUtc: string; closeUtc: string }): Promise<{ lines: string[]; flags: string[]; realGross: number }> {
  const reviewRows = await q<ReviewRow>(`SELECT * FROM trade_review WHERE trading_date = $1 ORDER BY entry_time`, [opts.date]);
  const reviewed = reviewRows.map(fromReviewRow);

  const [health, openPairs, skippedRows, cumRows, account] = await Promise.all([
    loadTickHealth(opts.openUtc, opts.closeUtc).catch(() => null),
    loadOpenPairs(opts.date, opts.closeUtc).catch(() => [] as OpenPairView[]),
    q<{ strategy_id: string; subject: string; reason: string; detail: string | null; signal: number | null; ticks: number }>(
      `SELECT strategy_id, subject, reason, detail, signal::float8 AS signal, ticks FROM skipped_signals
       WHERE trading_date = $1 ORDER BY ticks DESC, strategy_id, subject`,
      [opts.date]
    ),
    q<{ source: "real" | "lab"; strategy_id: string; n: number; net: number; wins: number; avgmae: number | null }>(
      `SELECT source, strategy_id, count(*)::int AS n, sum(net_pnl)::float8 AS net, sum((net_pnl > 0)::int)::int AS wins, avg(mae)::float8 AS avgmae
       FROM trade_review GROUP BY source, strategy_id ORDER BY source, strategy_id`
    ),
    alpacaFetch<{ equity: string; last_equity: string }>("/v2/account").catch(() => null),
  ]);

  let consistencyLines: string[] = [];
  let anomalies: string[] = [];
  try {
    const c = await withTimeout(runConsistencyChecks({ tradingDate: opts.date, sessionOpenUtc: opts.openUtc }), 8_000, "controllo di coerenza");
    consistencyLines = c.lines;
    anomalies = c.anomalies.map((a) => a.summary);
  } catch (err) {
    consistencyLines = [`Controllo di coerenza non eseguito: ${(err as Error).message}`];
  }

  const skipped: SkippedView[] = skippedRows.map((s) => ({
    strategyId: s.strategy_id,
    subject: s.subject,
    reason: s.reason,
    detail: s.detail,
    signal: s.signal != null ? Number(s.signal) : null,
    ticks: Number(s.ticks),
  }));
  const cumulative: CumulativeView[] = cumRows.map((c) => ({
    source: c.source,
    strategyId: c.strategy_id,
    n: Number(c.n),
    net: Number(c.net),
    wins: Number(c.wins),
    avgMae: c.avgmae != null ? Number(c.avgmae) : null,
  }));

  const input: ReportInput = {
    date: opts.date,
    equity: account ? { equity: Number(account.equity), lastEquity: Number(account.last_equity) } : null,
    real: reviewed.filter((t) => t.source === "real"),
    lab: reviewed.filter((t) => t.source === "lab"),
    openPairs,
    skipped,
    health,
    consistencyLines,
    anomalies,
    cumulative,
  };
  return {
    lines: buildDailyReport(input),
    flags: buildFlags(input),
    realGross: input.real.reduce((s, t) => s + t.grossPnl, 0),
  };
}

// ---------------------------------------------------------------------------------------------
// Orchestrazione dal tick
// ---------------------------------------------------------------------------------------------

interface ReviewState {
  attempts: number;
  phaseA?: boolean;
  done?: boolean;
  reason?: string;
  emailed?: boolean;
  emailNote?: string;
  flags?: number;
  lines?: string[];
}

async function loadState(date: string): Promise<ReviewState> {
  const rows = await q<{ value: ReviewState }>(
    `SELECT value FROM lab_state WHERE strategy_id = $1 AND trading_date = $2 AND key = $3`,
    [STATE_STRATEGY_ID, date, STATE_KEY]
  );
  return rows[0]?.value ?? { attempts: 0 };
}

async function saveState(date: string, state: ReviewState): Promise<void> {
  await db()`
    INSERT INTO lab_state (strategy_id, trading_date, key, value, updated_at)
    VALUES (${STATE_STRATEGY_ID}, ${date}, ${STATE_KEY}, ${JSON.stringify(state)}::jsonb, now())
    ON CONFLICT (strategy_id, trading_date, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `;
}

const money = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(0)}$`;

/** Restituisce una nota breve per la risposta del tick. Non lancia mai. */
export async function runDailyReviewIfDue(ctx: { now: Date; startedAtMs: number }): Promise<string> {
  try {
    const hourUtc = ctx.now.getUTCHours();
    // Finestra: dopo la chiusura (19-24 UTC) e fino a notte fonda; dopo mezzanotte UTC la seduta è "ieri".
    if (!(hourUtc >= 19 || hourUtc < 5)) return "review: fuori finestra";
    const day = new Date(ctx.now.getTime() - (hourUtc < 5 ? 24 * 3600_000 : 0));
    const date = day.toISOString().slice(0, 10);
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6) return "review: weekend";

    const state = await loadState(date);
    if (state.done) return "review: già eseguita";
    if (state.attempts >= MAX_ATTEMPTS) return `review: rinunciato dopo ${MAX_ATTEMPTS} tentativi`;

    const session = await fetchMarketSession(date);
    if (!session) {
      await saveState(date, { ...state, done: true, reason: "nessuna sessione di mercato" });
      return "review: nessuna sessione";
    }
    if (ctx.now.getTime() < Date.parse(session.closeUtc) + FIVE_MIN_MS) return "review: sessione non ancora chiusa";

    const next: ReviewState = { ...state, attempts: state.attempts + 1 };
    await saveState(date, next); // prima del lavoro: un blocco persistente non si ripete all'infinito

    let note = "";
    if (!next.phaseA) {
      const r = await withTimeout(reviewSession({ date, openUtc: session.openUtc, closeUtc: session.closeUtc }), PHASE_TIMEOUT_MS, "revisione trade");
      next.phaseA = true;
      await saveState(date, next);
      note = `trade rivisti (${r.real.length} reali, ${r.lab.length} lab)`;
      if (Date.now() - ctx.startedAtMs > CONTINUE_IF_ELAPSED_UNDER_MS) return `review: ${note}; rapporto al prossimo tick`;
    }

    const report = await withTimeout(buildReport({ date, openUtc: session.openUtc, closeUtc: session.closeUtc }), PHASE_TIMEOUT_MS, "rapporto");
    const subject = `WHAD — recap ${date}: ${report.flags.length === 0 ? "tutto regolare" : `${report.flags.length} da guardare`} · reale ${money(report.realGross)}`;
    const sent = await sendAlertEmail(subject, report.lines);
    await saveState(date, {
      ...next,
      done: true,
      emailed: sent.sent,
      emailNote: sent.sent ? undefined : sent.reason,
      flags: report.flags.length,
      lines: report.lines,
    });
    return `review: ${note ? `${note}; ` : ""}rapporto ${sent.sent ? "inviato" : `NON inviato (${sent.reason})`}, ${report.flags.length} punti di attenzione`;
  } catch (err) {
    return `review: errore (${(err as Error).message})`;
  }
}

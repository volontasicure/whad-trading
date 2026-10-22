// LAB D (trend ETF) e LAB E (rotazione ETF): esecutore (I/O) del ribilanciamento mensile e lettore di stato per la UI,
// compresa la vista del portafoglio proposto (50% LAB D + 50% LAB E + pairs del LAB B sovrapposto 1×). La logica pura
// (segnali, pesi, decisione) è in server/trendEtf.ts. SOLO LAB: scrive righe `lab_positions` con strategy_id "trend" o
// "rotation", nessun ordine reale.
//
// Garanzie, in ordine di importanza:
//   - non può disturbare l'esecuzione: è chiamato da api/cron/tick.ts DOPO tick_log e dopo ogni ordine reale,
//     dentro un try/catch, con timeout proprio e saltando il giro se il tick è già lento;
//   - nei tick normali costa UNA lettura da lab_state (stato di entrambi i lab e partenza del portafoglio proposto);
//     scarica dati solo quando un lab va ribilanciato (prima seduta del mese, prima esecuzione, cambio di parametri);
//   - le scritture di ogni lab (chiusure, aperture, stato) stanno in UNA transazione: un errore a metà non lascia righe
//     aperte senza stato (che il giro successivo duplicherebbe).

import { alpacaDataFetch } from "./alpaca.js";
import { db } from "./db.js";
import { LAB_NET_PNL_SQL } from "./costs.js";
import { STRATEGY_ID as PAIRS_STRATEGY_ID } from "./pairsTrading.js";
import {
  ALL_SYMBOLS,
  CAPITAL,
  CASH_SYMBOL,
  CORE_PARAMS,
  MIN_HISTORY,
  ROTATION_STRATEGY_ID,
  STRATEGY_ID as TREND_STRATEGY_ID,
  TREND_SYMBOLS,
  computeRotationWeights,
  computeTargetWeights,
  decideRebalance,
  isRebalanceDue,
  monthOf,
  type EtfSignal,
  type RotationScore,
  type TargetPlan,
} from "./trendEtf.js";

const STATE_KEY = "rebalance";
/** Partenza del portafoglio proposto: equity dei tre lab nel momento in cui partono insieme (lab_state, strategy_id "core"). */
const CORE_STATE_ID = "core";
const CORE_INCEPTION_KEY = "inception";
const RUN_TIMEOUT_MS = 8_000;
const SKIP_IF_TICK_SLOWER_THAN_MS = 6_000;

/** Pesi del portafoglio proposto (CLAUDE.md, "Ridisegno integrale"): CORE 50/50 + pairs sovrapposto 1×. */
export const CORE_WEIGHTS = { [TREND_STRATEGY_ID]: 0.5, [ROTATION_STRATEGY_ID]: 0.5, [PAIRS_STRATEGY_ID]: 1 } as const;

interface Sleeve {
  id: string;
  label: string;
  plan: (closes: Record<string, number[]>) => TargetPlan;
}
const SLEEVES: Sleeve[] = [
  { id: TREND_STRATEGY_ID, label: "trend", plan: (c) => computeTargetWeights(c) },
  { id: ROTATION_STRATEGY_ID, label: "rotazione", plan: (c) => computeRotationWeights(c) },
];

export interface RebalanceState {
  month: string;
  date: string;
  at: string;
  /** Versione dei parametri (CORE_PARAMS.version); assente negli stati del LAB D precedenti al 22/10/2026. */
  version?: string;
  equity: number;
  gross: number;
  portfolioVol: number;
  closes: number;
  opens: number;
  weights: Record<string, number>;
  signals: Record<string, EtfSignal>;
  scores?: Record<string, RotationScore>;
  cashScore?: number;
}

export interface CoreInception {
  at: string;
  date: string;
  /** Equity di ogni lab (100k di base) al momento della partenza. */
  equity: Record<string, number>;
}

async function q<T>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await db().query(text, params)) as unknown as T[];
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout dopo ${ms / 1000}s`)), ms);
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

/** In una sola lettura: ultimo ribilanciamento di ogni lab ETF e partenza del portafoglio proposto. */
async function loadStates(): Promise<{ last: Record<string, RebalanceState | null>; inception: CoreInception | null }> {
  const rows = await q<{ strategy_id: string; key: string; value: unknown }>(
    `SELECT DISTINCT ON (strategy_id, key) strategy_id, key, value FROM lab_state
     WHERE (strategy_id = ANY($1::text[]) AND key = $2) OR (strategy_id = $3 AND key = $4)
     ORDER BY strategy_id, key, trading_date DESC`,
    [SLEEVES.map((s) => s.id), STATE_KEY, CORE_STATE_ID, CORE_INCEPTION_KEY]
  );
  const last: Record<string, RebalanceState | null> = Object.fromEntries(SLEEVES.map((s) => [s.id, null]));
  let inception: CoreInception | null = null;
  for (const r of rows) {
    if (r.strategy_id === CORE_STATE_ID) inception = r.value as CoreInception;
    else last[r.strategy_id] = r.value as RebalanceState;
  }
  return { last, inception };
}

export async function loadLastRebalance(strategyId: string = TREND_STRATEGY_ID): Promise<RebalanceState | null> {
  return (await loadStates()).last[strategyId] ?? null;
}

interface DailyBarRaw {
  t: string;
  c: number;
}

/** Chiusure giornaliere (rettificate per split e dividendi) fino all'ULTIMA SEDUTA COMPLETA, mai la barra di oggi. */
export async function fetchCloses(todayIso: string): Promise<Record<string, number[]>> {
  const start = new Date(new Date(`${todayIso}T00:00:00Z`).getTime() - 430 * 86_400_000).toISOString().slice(0, 10);
  const end = new Date(new Date(`${todayIso}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
  const symbols = ALL_SYMBOLS.join(",");
  const attempt = async (feed: "sip" | "iex"): Promise<Record<string, DailyBarRaw[]>> => {
    const merged: Record<string, DailyBarRaw[]> = {};
    let token: string | null = null;
    for (;;) {
      const path: string =
        `/v2/stocks/bars?symbols=${symbols}&timeframe=1Day&start=${start}&end=${end}&adjustment=all&feed=${feed}&limit=10000` +
        (token ? `&page_token=${encodeURIComponent(token)}` : "");
      const raw: { bars?: Record<string, DailyBarRaw[]>; next_page_token?: string | null } = await alpacaDataFetch(path);
      for (const [s, bars] of Object.entries(raw.bars ?? {})) (merged[s] ??= []).push(...bars);
      token = raw.next_page_token ?? null;
      if (!token) break;
    }
    return merged;
  };
  let bars: Record<string, DailyBarRaw[]>;
  try {
    bars = await attempt("sip"); // storico completo (consolidato); su alcuni account il feed sip può non essere disponibile
  } catch {
    bars = await attempt("iex");
  }
  const out: Record<string, number[]> = {};
  for (const s of ALL_SYMBOLS) out[s] = (bars[s] ?? []).filter((b) => b.t.slice(0, 10) <= end).map((b) => b.c);
  return out;
}

interface SnapshotRaw {
  latestTrade?: { p: number };
  dailyBar?: { c: number };
}

/** Ultimo prezzo dei simboli richiesti (default: tutti gli ETF dei lab, BIL compreso). */
export async function fetchPrices(symbols: readonly string[] = ALL_SYMBOLS): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (symbols.length === 0) return out;
  const raw = await alpacaDataFetch<Record<string, SnapshotRaw>>(`/v2/stocks/snapshots?symbols=${symbols.join(",")}&feed=iex`);
  for (const s of symbols) {
    const p = raw[s]?.latestTrade?.p ?? raw[s]?.dailyBar?.c;
    if (p != null) out[s] = p;
  }
  return out;
}

interface OpenRow {
  id: number;
  strategy_id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  entry_price: number;
  entry_time: string;
}

async function loadOpenRows(strategyIds: string[]): Promise<OpenRow[]> {
  return q<OpenRow>(
    `SELECT id, strategy_id, symbol, side, qty::float8 AS qty, entry_price::float8 AS entry_price, entry_time
     FROM lab_positions WHERE strategy_id = ANY($1::text[]) AND status = 'open' ORDER BY id`,
    [strategyIds]
  );
}

async function loadNetRealized(strategyIds: string[]): Promise<Record<string, number>> {
  const rows = await q<{ strategy_id: string; net: number }>(
    `SELECT strategy_id, coalesce(sum(${LAB_NET_PNL_SQL}), 0)::float8 AS net FROM lab_positions
     WHERE strategy_id = ANY($1::text[]) AND status = 'closed' GROUP BY strategy_id`,
    [strategyIds]
  );
  const out: Record<string, number> = Object.fromEntries(strategyIds.map((id) => [id, 0]));
  for (const r of rows) out[r.strategy_id] = r.net;
  return out;
}

function unrealizedOf(rows: OpenRow[], prices: Record<string, number>): { value: number; missing: number } {
  let value = 0;
  let missing = 0;
  for (const r of rows) {
    const px = prices[r.symbol];
    if (px == null) missing++;
    else value += r.qty * (px - r.entry_price) * (r.side === "SHORT" ? -1 : 1);
  }
  return { value, missing };
}

/** Esegue i ribilanciamenti dovuti. Restituisce una nota breve per la risposta del tick. Non lancia mai. */
export async function runTrendIfDue(ctx: { now: Date; tradingDate: string; startedAtMs: number }): Promise<string> {
  const note = await decideAndRun(ctx);
  // Visibilità: l'esito di ogni tentativo (tranne il "non dovuto" dei tick normali) resta in lab_state, perché la
  // risposta del tick non è registrata da nessuna parte. Best-effort.
  if (note !== "etf: non dovuto") {
    try {
      await db()`
        INSERT INTO lab_state (strategy_id, trading_date, key, value, updated_at)
        VALUES (${TREND_STRATEGY_ID}, ${ctx.tradingDate}, 'last_run', ${JSON.stringify({ at: ctx.now.toISOString(), note })}::jsonb, now())
        ON CONFLICT (strategy_id, trading_date, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      `;
    } catch {
      /* best-effort */
    }
  }
  return note;
}

async function decideAndRun(ctx: { now: Date; tradingDate: string; startedAtMs: number }): Promise<string> {
  const elapsed = Date.now() - ctx.startedAtMs;
  if (elapsed > SKIP_IF_TICK_SLOWER_THAN_MS) return `etf: saltato (tick già lento: ${Math.round(elapsed / 100) / 10}s)`;
  try {
    const { last, inception } = await loadStates();
    const due = SLEEVES.filter((s) => isRebalanceDue(last[s.id]?.month ?? null, ctx.tradingDate, last[s.id]?.version ?? null));
    if (due.length === 0 && inception) return "etf: non dovuto";
    return await withTimeout(rebalance(ctx, due, inception), RUN_TIMEOUT_MS);
  } catch (err) {
    return `etf: errore (${(err as Error).message})`;
  }
}

async function rebalance(ctx: { now: Date; tradingDate: string }, due: Sleeve[], inception: CoreInception | null): Promise<string> {
  const notes: string[] = [];
  if (due.length > 0) {
    const ids = due.map((s) => s.id);
    const [closes, prices, open, netRealized] = await Promise.all([fetchCloses(ctx.tradingDate), fetchPrices(), loadOpenRows(ids), loadNetRealized(ids)]);
    const usable = TREND_SYMBOLS.filter((s) => (closes[s]?.length ?? 0) >= MIN_HISTORY && prices[s] != null);
    // Pochi ETF utilizzabili (o senza i T-bill) = dati incompleti: meglio non ribilanciare che costruire un portafoglio storto.
    if (usable.length < 8 || prices[CASH_SYMBOL] == null || (closes[CASH_SYMBOL]?.length ?? 0) < MIN_HISTORY)
      return `etf: dati insufficienti (${usable.length}/12 ETF con storico e prezzo${prices[CASH_SYMBOL] == null ? ", BIL senza prezzo" : ""}), riprovo`;

    const nowIso = ctx.now.toISOString();
    for (const sleeve of due) {
      const rows = open.filter((r) => r.strategy_id === sleeve.id);
      const equity = CAPITAL + netRealized[sleeve.id] + unrealizedOf(rows, prices).value;
      const plan = sleeve.plan(closes);
      const decision = decideRebalance(
        plan,
        equity,
        prices,
        rows.map((r) => ({ id: r.id, symbol: r.symbol, qty: r.qty, entryPrice: r.entry_price }))
      );
      const state: RebalanceState = {
        month: monthOf(ctx.tradingDate),
        date: ctx.tradingDate,
        at: nowIso,
        version: CORE_PARAMS.version,
        equity,
        gross: plan.gross,
        portfolioVol: plan.portfolioVol,
        closes: decision.closes.length,
        opens: decision.opens.length,
        weights: plan.weights,
        signals: plan.signals,
        scores: plan.scores,
        cashScore: plan.cashScore,
      };
      await db().transaction((tx) => [
        ...decision.closes.map(
          (c) => tx`UPDATE lab_positions SET status = 'closed', exit_price = ${c.exitPrice}, exit_time = ${nowIso}, realized_pnl = ${c.realizedPnl}, exit_reason = 'rebalance' WHERE id = ${c.id} AND status = 'open'`
        ),
        ...decision.opens.map(
          (o) => tx`INSERT INTO lab_positions (strategy_id, symbol, side, qty, entry_price, entry_time, status) VALUES (${sleeve.id}, ${o.symbol}, 'LONG', ${o.qty}, ${o.price}, ${nowIso}, 'open')`
        ),
        tx`INSERT INTO lab_state (strategy_id, trading_date, key, value, updated_at) VALUES (${sleeve.id}, ${ctx.tradingDate}, ${STATE_KEY}, ${JSON.stringify(state)}::jsonb, now())
           ON CONFLICT (strategy_id, trading_date, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      ]);
      const held = TREND_SYMBOLS.filter((s) => (plan.weights[s] ?? 0) > 0).length;
      notes.push(`${sleeve.label} ribilanciato (${decision.closes.length} chiuse, ${decision.opens.length} aperte, ${held} ETF, rischio ${(plan.gross * 100).toFixed(0)}% + BIL)`);
    }
  }

  // Partenza del portafoglio proposto: la prima volta che entrambi i lab ETF hanno un ribilanciamento con i parametri
  // correnti, si fotografa l'equity dei tre lab. Da lì in poi il P&L del portafoglio = somma pesata delle variazioni.
  if (!inception) {
    const { last } = await loadStates();
    if (SLEEVES.every((s) => last[s.id]?.version === CORE_PARAMS.version)) {
      const ids = [TREND_STRATEGY_ID, ROTATION_STRATEGY_ID, PAIRS_STRATEGY_ID];
      const [open, netRealized] = await Promise.all([loadOpenRows(ids), loadNetRealized(ids)]);
      const stockSymbols = [...new Set(open.filter((r) => r.strategy_id === PAIRS_STRATEGY_ID).map((r) => r.symbol))];
      const [etfPrices, stockPrices] = await Promise.all([fetchPrices(), fetchPrices(stockSymbols)]);
      const prices = { ...etfPrices, ...stockPrices };
      const equity: Record<string, number> = {};
      for (const id of ids) {
        const u = unrealizedOf(open.filter((r) => r.strategy_id === id), prices);
        if (u.missing > 0) return [...notes, "portafoglio proposto: prezzi mancanti, partenza rinviata"].join(" · ");
        equity[id] = CAPITAL + netRealized[id] + u.value;
      }
      const value: CoreInception = { at: ctx.now.toISOString(), date: ctx.tradingDate, equity };
      await db()`
        INSERT INTO lab_state (strategy_id, trading_date, key, value, updated_at)
        VALUES (${CORE_STATE_ID}, ${ctx.tradingDate}, ${CORE_INCEPTION_KEY}, ${JSON.stringify(value)}::jsonb, now())
        ON CONFLICT (strategy_id, trading_date, key) DO NOTHING
      `;
      notes.push("portafoglio proposto avviato");
    }
  }
  return notes.length ? `etf: ${notes.join(" · ")}` : "etf: non dovuto";
}

// ---------------------------------------------------------------------------------------------
// Stato per la UI (sola lettura)
// ---------------------------------------------------------------------------------------------

export interface TrendRow {
  symbol: string;
  qty: number;
  entryPrice: number | null;
  last: number | null;
  value: number;
  weightPct: number;
  unrealized: number;
  signal: { close: number; sma: number; distancePct: number; above: boolean; volPct: number } | null;
  /** Solo rotazione: momentum medio (%), posizione in classifica, scelto o no. */
  score: { scorePct: number; rank: number; selected: boolean } | null;
  targetWeightPct: number;
}

export interface TrendSnapshot {
  strategyId: string;
  capital: number;
  equity: number;
  pnl: number;
  pnlPct: number;
  realizedNet: number;
  unrealized: number;
  /** Quota in T-bill (BIL) e quota in contanti non investiti, in % dell'equity. */
  billsPct: number;
  cashPct: number;
  startedAt: string | null;
  lastRebalance: { date: string; month: string; closes: number; opens: number; gross: number; portfolioVol: number; version: string | null } | null;
  nextRebalanceMonth: string;
  /** Solo rotazione: momentum dei T-bill, la soglia che un ETF deve battere (%). */
  cashScorePct: number | null;
  rows: TrendRow[];
}

export interface CoreSnapshot {
  startedAt: string | null;
  startDate: string | null;
  capital: number;
  weights: Record<string, number>;
  /** P&L di ogni lab dalla partenza (non pesato) e contributo pesato al portafoglio. */
  parts: { strategyId: string; pnl: number; weight: number; contribution: number }[];
  pnl: number;
  pnlPct: number;
  equity: number;
  /** Esposizione lorda del portafoglio proposto in % del capitale (CORE + gambe del pairs), per il controllo del margine. */
  grossPct: number;
}

export interface EtfLabsSnapshot {
  pricesAvailable: boolean;
  params: typeof CORE_PARAMS;
  trend: TrendSnapshot;
  rotation: TrendSnapshot;
  core: CoreSnapshot;
}

function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

function sleeveSnapshot(
  strategyId: string,
  state: RebalanceState | null,
  open: OpenRow[],
  netRealized: number,
  prices: Record<string, number>,
  firstEntry: string | null,
  todayIso: string
): TrendSnapshot {
  const bySymbol = new Map<string, { qty: number; cost: number }>();
  for (const r of open) {
    const cur = bySymbol.get(r.symbol) ?? { qty: 0, cost: 0 };
    cur.qty += r.qty;
    cur.cost += r.qty * r.entry_price;
    bySymbol.set(r.symbol, cur);
  }
  let unrealized = 0;
  let invested = 0;
  let bills = 0;
  for (const [s, h] of bySymbol) {
    const px = prices[s];
    const value = px != null ? h.qty * px : h.cost;
    if (px != null) unrealized += value - h.cost;
    invested += value;
    if (s === CASH_SYMBOL) bills += value;
  }
  const equity = CAPITAL + netRealized + unrealized;
  const rows: TrendRow[] = ALL_SYMBOLS.map((symbol) => {
    const h = bySymbol.get(symbol);
    const last = prices[symbol] ?? null;
    const sig = state?.signals?.[symbol] ?? null;
    const sc = state?.scores?.[symbol] ?? null;
    const value = h ? h.qty * (last ?? h.cost / h.qty) : 0;
    return {
      symbol,
      qty: h?.qty ?? 0,
      entryPrice: h ? h.cost / h.qty : null,
      last,
      value,
      weightPct: equity > 0 ? (value / equity) * 100 : 0,
      unrealized: h && last != null ? h.qty * last - h.cost : 0,
      signal: sig ? { close: sig.close, sma: sig.sma, distancePct: (sig.close / sig.sma - 1) * 100, above: sig.above, volPct: sig.vol * 100 } : null,
      score: sc ? { scorePct: sc.score * 100, rank: sc.rank, selected: sc.selected } : null,
      targetWeightPct: (state?.weights?.[symbol] ?? 0) * 100,
    };
  });
  return {
    strategyId,
    capital: CAPITAL,
    equity,
    pnl: equity - CAPITAL,
    pnlPct: ((equity - CAPITAL) / CAPITAL) * 100,
    realizedNet: netRealized,
    unrealized,
    billsPct: equity > 0 ? (bills / equity) * 100 : 0,
    cashPct: equity > 0 ? ((equity - invested) / equity) * 100 : 100,
    startedAt: firstEntry,
    lastRebalance: state
      ? { date: state.date, month: state.month, closes: state.closes, opens: state.opens, gross: state.gross, portfolioVol: state.portfolioVol, version: state.version ?? null }
      : null,
    nextRebalanceMonth: state ? nextMonth(state.month) : monthOf(todayIso),
    cashScorePct: state?.cashScore != null ? state.cashScore * 100 : null,
    rows,
  };
}

export async function buildTrendSnapshot(todayIso: string): Promise<EtfLabsSnapshot> {
  const ids = [TREND_STRATEGY_ID, ROTATION_STRATEGY_ID, PAIRS_STRATEGY_ID];
  const [{ last, inception }, open, netRealized, first] = await Promise.all([
    loadStates(),
    loadOpenRows(ids),
    loadNetRealized(ids),
    q<{ strategy_id: string; t: string | null }>(`SELECT strategy_id, min(entry_time) AS t FROM lab_positions WHERE strategy_id = ANY($1::text[]) GROUP BY strategy_id`, [
      [TREND_STRATEGY_ID, ROTATION_STRATEGY_ID],
    ]),
  ]);
  const stockSymbols = [...new Set(open.filter((r) => r.strategy_id === PAIRS_STRATEGY_ID).map((r) => r.symbol))];
  let prices: Record<string, number> = {};
  let pricesAvailable = true;
  try {
    const [a, b] = await Promise.all([fetchPrices(), fetchPrices(stockSymbols)]);
    prices = { ...a, ...b };
  } catch {
    pricesAvailable = false;
  }
  const firstOf = (id: string) => {
    const t = first.find((f) => f.strategy_id === id)?.t;
    return t ? new Date(t).toISOString() : null;
  };
  const rowsOf = (id: string) => open.filter((r) => r.strategy_id === id);
  const trend = sleeveSnapshot(TREND_STRATEGY_ID, last[TREND_STRATEGY_ID], rowsOf(TREND_STRATEGY_ID), netRealized[TREND_STRATEGY_ID], prices, firstOf(TREND_STRATEGY_ID), todayIso);
  const rotation = sleeveSnapshot(ROTATION_STRATEGY_ID, last[ROTATION_STRATEGY_ID], rowsOf(ROTATION_STRATEGY_ID), netRealized[ROTATION_STRATEGY_ID], prices, firstOf(ROTATION_STRATEGY_ID), todayIso);

  // Pairs: equity del LAB B (100k + realizzato netto + non realizzato) per la parte sovrapposta.
  const pairsRows = rowsOf(PAIRS_STRATEGY_ID);
  const pairsEquity = CAPITAL + netRealized[PAIRS_STRATEGY_ID] + unrealizedOf(pairsRows, prices).value;
  const equityNow: Record<string, number> = { [TREND_STRATEGY_ID]: trend.equity, [ROTATION_STRATEGY_ID]: rotation.equity, [PAIRS_STRATEGY_ID]: pairsEquity };
  const parts = ids.map((id) => {
    const pnl = inception ? equityNow[id] - (inception.equity[id] ?? CAPITAL) : 0;
    const weight = CORE_WEIGHTS[id as keyof typeof CORE_WEIGHTS];
    return { strategyId: id, pnl, weight, contribution: pnl * weight };
  });
  const pnl = parts.reduce((s, p) => s + p.contribution, 0);
  const pairsGross = pairsRows.reduce((s, r) => s + r.qty * (prices[r.symbol] ?? r.entry_price), 0);
  const invested = (snap: TrendSnapshot) => snap.rows.reduce((s, r) => s + r.value, 0); // ETF + BIL
  const coreGross = CORE_WEIGHTS[TREND_STRATEGY_ID] * invested(trend) + CORE_WEIGHTS[ROTATION_STRATEGY_ID] * invested(rotation);
  const core: CoreSnapshot = {
    startedAt: inception?.at ?? null,
    startDate: inception?.date ?? null,
    capital: CAPITAL,
    weights: { ...CORE_WEIGHTS },
    parts,
    pnl,
    pnlPct: (pnl / CAPITAL) * 100,
    equity: CAPITAL + pnl,
    grossPct: ((coreGross + pairsGross) / CAPITAL) * 100,
  };
  return { pricesAvailable, params: CORE_PARAMS, trend, rotation, core };
}

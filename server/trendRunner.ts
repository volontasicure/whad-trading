// LAB D — Trend ETF: esecutore (I/O) del ribilanciamento mensile e lettore di stato per la UI. La logica
// pura (segnali, pesi, decisione) è in server/trendEtf.ts. SOLO LAB: scrive righe `lab_positions` con
// strategy_id "trend", nessun ordine reale.
//
// Garanzie, in ordine di importanza:
//   - non può disturbare l'esecuzione: è chiamato da api/cron/tick.ts DOPO tick_log e dopo ogni ordine reale,
//     dentro un try/catch, con timeout proprio e saltando il giro se il tick è già lento;
//   - gira una volta al mese (alla prima esecuzione in assoluto e alla prima seduta di ogni mese), quindi nei
//     tick normali costa UNA lettura da lab_state;
//   - tutte le scritture (chiusure, aperture, stato) stanno in UNA transazione: un errore a metà non lascia
//     righe aperte senza stato (che il giro successivo duplicherebbe).

import { alpacaDataFetch } from "./alpaca.js";
import { db } from "./db.js";
import { LAB_NET_PNL_SQL } from "./costs.js";
import {
  CAPITAL,
  MIN_HISTORY,
  STRATEGY_ID,
  TREND_SYMBOLS,
  computeTargetWeights,
  decideRebalance,
  isRebalanceDue,
  monthOf,
  type EtfSignal,
} from "./trendEtf.js";

const STATE_KEY = "rebalance";
const RUN_TIMEOUT_MS = 8_000;
const SKIP_IF_TICK_SLOWER_THAN_MS = 6_000;

export interface RebalanceState {
  month: string;
  date: string;
  at: string;
  equity: number;
  gross: number;
  portfolioVol: number;
  closes: number;
  opens: number;
  weights: Record<string, number>;
  signals: Record<string, EtfSignal>;
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

export async function loadLastRebalance(): Promise<RebalanceState | null> {
  const rows = await q<{ value: RebalanceState }>(
    `SELECT value FROM lab_state WHERE strategy_id = $1 AND key = $2 ORDER BY trading_date DESC LIMIT 1`,
    [STRATEGY_ID, STATE_KEY]
  );
  return rows[0]?.value ?? null;
}

interface DailyBarRaw {
  t: string;
  c: number;
}

/** Chiusure giornaliere (rettificate per split e dividendi) fino all'ULTIMA SEDUTA COMPLETA, mai la barra di oggi. */
export async function fetchCloses(todayIso: string): Promise<Record<string, number[]>> {
  const start = new Date(new Date(`${todayIso}T00:00:00Z`).getTime() - 430 * 86_400_000).toISOString().slice(0, 10);
  const end = new Date(new Date(`${todayIso}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
  const symbols = TREND_SYMBOLS.join(",");
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
  for (const s of TREND_SYMBOLS) out[s] = (bars[s] ?? []).filter((b) => b.t.slice(0, 10) <= end).map((b) => b.c);
  return out;
}

interface SnapshotRaw {
  latestTrade?: { p: number };
  dailyBar?: { c: number };
}

export async function fetchPrices(): Promise<Record<string, number>> {
  const raw = await alpacaDataFetch<Record<string, SnapshotRaw>>(`/v2/stocks/snapshots?symbols=${TREND_SYMBOLS.join(",")}&feed=iex`);
  const out: Record<string, number> = {};
  for (const s of TREND_SYMBOLS) {
    const p = raw[s]?.latestTrade?.p ?? raw[s]?.dailyBar?.c;
    if (p != null) out[s] = p;
  }
  return out;
}

interface OpenRow {
  id: number;
  symbol: string;
  qty: number;
  entry_price: number;
  entry_time: string;
}

async function loadOpenRows(): Promise<OpenRow[]> {
  return q<OpenRow>(
    `SELECT id, symbol, qty::float8 AS qty, entry_price::float8 AS entry_price, entry_time
     FROM lab_positions WHERE strategy_id = $1 AND status = 'open' ORDER BY id`,
    [STRATEGY_ID]
  );
}

async function loadNetRealized(): Promise<number> {
  const rows = await q<{ net: number | null }>(
    `SELECT coalesce(sum(${LAB_NET_PNL_SQL}), 0)::float8 AS net FROM lab_positions WHERE strategy_id = $1 AND status = 'closed'`,
    [STRATEGY_ID]
  );
  return rows[0]?.net ?? 0;
}

/** Esegue il ribilanciamento se dovuto. Restituisce una nota breve per la risposta del tick. Non lancia mai. */
export async function runTrendIfDue(ctx: { now: Date; tradingDate: string; startedAtMs: number }): Promise<string> {
  const note = await decideAndRun(ctx);
  // Visibilità: l'esito di ogni tentativo (tranne il "non dovuto" dei tick normali) resta in lab_state, perché la
  // risposta del tick non è registrata da nessuna parte. Best-effort.
  if (note !== "trend: non dovuto") {
    try {
      await db()`
        INSERT INTO lab_state (strategy_id, trading_date, key, value, updated_at)
        VALUES (${STRATEGY_ID}, ${ctx.tradingDate}, 'last_run', ${JSON.stringify({ at: ctx.now.toISOString(), note })}::jsonb, now())
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
  if (elapsed > SKIP_IF_TICK_SLOWER_THAN_MS) return `trend: saltato (tick già lento: ${Math.round(elapsed / 100) / 10}s)`;
  try {
    const last = await loadLastRebalance();
    if (!isRebalanceDue(last?.month ?? null, ctx.tradingDate)) return "trend: non dovuto";
    return await withTimeout(rebalance(ctx), RUN_TIMEOUT_MS);
  } catch (err) {
    return `trend: errore (${(err as Error).message})`;
  }
}

async function rebalance(ctx: { now: Date; tradingDate: string }): Promise<string> {
  const [closes, prices, open, netRealized] = await Promise.all([fetchCloses(ctx.tradingDate), fetchPrices(), loadOpenRows(), loadNetRealized()]);
  const usable = TREND_SYMBOLS.filter((s) => (closes[s]?.length ?? 0) >= MIN_HISTORY && prices[s] != null);
  // Pochi ETF utilizzabili = dati incompleti: meglio non ribilanciare che costruire un portafoglio storto.
  if (usable.length < 8) return `trend: dati insufficienti (${usable.length}/12 ETF con storico e prezzo), riprovo`;

  const unrealized = open.reduce((s, r) => s + (prices[r.symbol] != null ? r.qty * (prices[r.symbol] - r.entry_price) : 0), 0);
  const equity = CAPITAL + netRealized + unrealized;
  const plan = computeTargetWeights(closes);
  const decision = decideRebalance(
    plan,
    equity,
    prices,
    open.map((r) => ({ id: r.id, symbol: r.symbol, qty: r.qty, entryPrice: r.entry_price }))
  );
  const nowIso = ctx.now.toISOString();
  const state: RebalanceState = {
    month: monthOf(ctx.tradingDate),
    date: ctx.tradingDate,
    at: nowIso,
    equity,
    gross: plan.gross,
    portfolioVol: plan.portfolioVol,
    closes: decision.closes.length,
    opens: decision.opens.length,
    weights: plan.weights,
    signals: plan.signals,
  };

  await db().transaction((tx) => [
    ...decision.closes.map(
      (c) => tx`UPDATE lab_positions SET status = 'closed', exit_price = ${c.exitPrice}, exit_time = ${nowIso}, realized_pnl = ${c.realizedPnl}, exit_reason = 'rebalance' WHERE id = ${c.id} AND status = 'open'`
    ),
    ...decision.opens.map(
      (o) => tx`INSERT INTO lab_positions (strategy_id, symbol, side, qty, entry_price, entry_time, status) VALUES (${STRATEGY_ID}, ${o.symbol}, 'LONG', ${o.qty}, ${o.price}, ${nowIso}, 'open')`
    ),
    tx`INSERT INTO lab_state (strategy_id, trading_date, key, value, updated_at) VALUES (${STRATEGY_ID}, ${ctx.tradingDate}, ${STATE_KEY}, ${JSON.stringify(state)}::jsonb, now())
       ON CONFLICT (strategy_id, trading_date, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
  ]);

  const held = TREND_SYMBOLS.filter((s) => plan.weights[s] > 0).length;
  return `trend: ribilanciato (${decision.closes.length} chiuse, ${decision.opens.length} aperte, ${held} ETF sopra la media, esposizione ${(plan.gross * 100).toFixed(0)}%)`;
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
  targetWeightPct: number;
}

export interface TrendSnapshot {
  capital: number;
  equity: number;
  pnl: number;
  pnlPct: number;
  realizedNet: number;
  unrealized: number;
  cashPct: number;
  startedAt: string | null;
  lastRebalance: { date: string; month: string; closes: number; opens: number; gross: number; portfolioVol: number } | null;
  nextRebalanceMonth: string;
  rows: TrendRow[];
  pricesAvailable: boolean;
}

function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

export async function buildTrendSnapshot(todayIso: string): Promise<TrendSnapshot> {
  const [state, open, netRealized, first] = await Promise.all([
    loadLastRebalance(),
    loadOpenRows(),
    loadNetRealized(),
    q<{ t: string | null }>(`SELECT min(entry_time) AS t FROM lab_positions WHERE strategy_id = $1`, [STRATEGY_ID]),
  ]);
  let prices: Record<string, number> = {};
  let pricesAvailable = true;
  try {
    prices = await fetchPrices();
  } catch {
    pricesAvailable = false;
  }

  const bySymbol = new Map<string, { qty: number; cost: number }>();
  for (const r of open) {
    const cur = bySymbol.get(r.symbol) ?? { qty: 0, cost: 0 };
    cur.qty += r.qty;
    cur.cost += r.qty * r.entry_price;
    bySymbol.set(r.symbol, cur);
  }
  let unrealized = 0;
  let invested = 0;
  for (const [s, h] of bySymbol) {
    const px = prices[s];
    if (px != null) {
      unrealized += h.qty * px - h.cost;
      invested += h.qty * px;
    } else invested += h.cost;
  }
  const equity = CAPITAL + netRealized + unrealized;

  const rows: TrendRow[] = TREND_SYMBOLS.map((symbol) => {
    const h = bySymbol.get(symbol);
    const last = prices[symbol] ?? null;
    const sig = state?.signals?.[symbol] ?? null;
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
      targetWeightPct: (state?.weights?.[symbol] ?? 0) * 100,
    };
  });

  return {
    capital: CAPITAL,
    equity,
    pnl: equity - CAPITAL,
    pnlPct: ((equity - CAPITAL) / CAPITAL) * 100,
    realizedNet: netRealized,
    unrealized,
    cashPct: equity > 0 ? ((equity - invested) / equity) * 100 : 100,
    startedAt: first[0]?.t ? new Date(first[0].t).toISOString() : null,
    lastRebalance: state ? { date: state.date, month: state.month, closes: state.closes, opens: state.opens, gross: state.gross, portfolioVol: state.portfolioVol } : null,
    nextRebalanceMonth: state ? nextMonth(state.month) : monthOf(todayIso),
    rows,
    pricesAvailable,
  };
}

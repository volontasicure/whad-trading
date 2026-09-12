import type { VercelRequest, VercelResponse } from "@vercel/node";
import { alpacaDataFetch, alpacaFetch } from "../../server/alpaca.js";
import { db } from "../../server/db.js";
import { UNIVERSE_SYMBOLS } from "../../server/universe.js";
import { decideLabEodCloses, type LabOpenRow } from "../../server/labEod.js";
import {
  ATR_THRESHOLD_PCT as ORB_ATR_THRESHOLD_PCT,
  MAX_POSITIONS as ORB_MAX_POSITIONS,
  STRATEGY_ID as ORB_STRATEGY_ID,
  computeATRPct,
  computeOpeningRange,
  decideEntries as decideOrbEntries,
  decideExits as decideOrbExits,
  type DailyBar as OrbDailyBar,
  type EntryInputs as OrbEntryInputs,
  type OpenPosition as OrbOpenPosition,
  type OpeningRange,
} from "../../server/orb.js";
import {
  MAX_PAIRS,
  STRATEGY_ID as PAIRS_STRATEGY_ID,
  decideEntries as decidePairsEntries,
  decideExits as decidePairsExits,
  pairKey,
  selectPairs,
  type OpenLeg,
  type PairStats,
} from "../../server/pairsTrading.js";
import {
  MAX_POSITIONS as VWAP_MAX_POSITIONS,
  STRATEGY_ID as VWAP_STRATEGY_ID,
  decideEntries as decideVwapEntries,
  decideExits as decideVwapExits,
  type OpenPosition as VwapOpenPosition,
  type Snapshot as VwapSnapshot,
} from "../../server/vwapReversion.js";

const EOD_CLOSE_WINDOW_MINUTES = 20;

interface AlpacaClock {
  is_open: boolean;
  next_close: string;
  next_open: string;
}

interface AlpacaSnapshotRaw {
  latestTrade?: { p: number };
  dailyBar?: { c: number; vw: number };
}

interface AlpacaDailyBarRaw {
  t: string;
  h: number;
  l: number;
  c: number;
}

interface AlpacaIntradayBarRaw {
  t: string;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface FullSnapshot {
  price: number;
  vwap: number;
}

async function fetchSnapshots(): Promise<Record<string, FullSnapshot>> {
  const symbols = UNIVERSE_SYMBOLS.join(",");
  const raw = await alpacaDataFetch<Record<string, AlpacaSnapshotRaw>>(
    `/v2/stocks/snapshots?symbols=${encodeURIComponent(symbols)}&feed=iex`
  );
  const out: Record<string, FullSnapshot> = {};
  for (const symbol of UNIVERSE_SYMBOLS) {
    const s = raw[symbol];
    const price = s?.dailyBar?.c ?? s?.latestTrade?.p;
    const vwap = s?.dailyBar?.vw;
    if (price != null && vwap != null) out[symbol] = { price, vwap };
  }
  return out;
}

async function fetchTodaySessionBars(now: Date): Promise<Record<string, AlpacaIntradayBarRaw[]>> {
  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);
  const symbols = UNIVERSE_SYMBOLS.join(",");
  const raw = await alpacaDataFetch<{ bars?: Record<string, AlpacaIntradayBarRaw[]> }>(
    `/v2/stocks/bars?symbols=${encodeURIComponent(symbols)}&timeframe=5Min&limit=3000&feed=iex&sort=asc&start=${encodeURIComponent(todayStart.toISOString())}`
  );
  const out: Record<string, AlpacaIntradayBarRaw[]> = {};
  for (const symbol of UNIVERSE_SYMBOLS) out[symbol] = raw.bars?.[symbol] ?? [];
  return out;
}

async function fetchDailyBars(days: number): Promise<Record<string, OrbDailyBar[]>> {
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const symbols = UNIVERSE_SYMBOLS.join(",");
  const raw = await alpacaDataFetch<{ bars?: Record<string, AlpacaDailyBarRaw[]> }>(
    `/v2/stocks/bars?symbols=${encodeURIComponent(symbols)}&timeframe=1Day&limit=10000&feed=iex&sort=asc&start=${encodeURIComponent(start)}`
  );
  const out: Record<string, OrbDailyBar[]> = {};
  for (const symbol of UNIVERSE_SYMBOLS) out[symbol] = raw.bars?.[symbol] ?? [];
  return out;
}

async function getCachedState<T>(strategyId: string, tradingDate: string, key: string): Promise<T | null> {
  const rows = (await db()`
    SELECT value FROM lab_state WHERE strategy_id = ${strategyId} AND trading_date = ${tradingDate} AND key = ${key}
  `) as unknown as { value: T }[];
  return rows[0]?.value ?? null;
}

async function setCachedState(strategyId: string, tradingDate: string, key: string, value: unknown): Promise<void> {
  await db()`
    INSERT INTO lab_state (strategy_id, trading_date, key, value, updated_at)
    VALUES (${strategyId}, ${tradingDate}, ${key}, ${JSON.stringify(value)}::jsonb, now())
    ON CONFLICT (strategy_id, trading_date, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `;
}

interface LabPositionRow {
  id: number;
  strategy_id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  entry_price: number;
  entry_time: string;
  pair_key: string | null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = req.headers.authorization;
  if (!process.env.TICK_SECRET || auth !== `Bearer ${process.env.TICK_SECRET}`) {
    res.status(401).json({ error: "Non autorizzato" });
    return;
  }

  try {
    const clock = await alpacaFetch<AlpacaClock>("/v2/clock");
    if (!clock.is_open) {
      const note = `mercato chiuso, prossima apertura ${clock.next_open}`;
      await db()`INSERT INTO tick_log (market_open, note) VALUES (false, ${note})`;
      res.status(200).json({ marketOpen: false, note });
      return;
    }

    const now = new Date();
    const tradingDate = now.toISOString().slice(0, 10);
    const minutesToClose = (new Date(clock.next_close).getTime() - now.getTime()) / 60_000;
    const nearClose = minutesToClose <= EOD_CLOSE_WINDOW_MINUTES;

    const [snapshots, sessionBars, openRows] = await Promise.all([
      fetchSnapshots(),
      fetchTodaySessionBars(now),
      db()`
        SELECT id, strategy_id, symbol, side, qty::float8 AS qty, entry_price::float8 AS entry_price, entry_time, pair_key
        FROM lab_positions WHERE status = 'open'
      ` as unknown as Promise<LabPositionRow[]>,
    ]);

    const prices: Record<string, number> = {};
    for (const [symbol, s] of Object.entries(snapshots)) prices[symbol] = s.price;

    const vwapOpen: VwapOpenPosition[] = openRows
      .filter((r) => r.strategy_id === VWAP_STRATEGY_ID)
      .map((r) => ({ id: r.id, symbol: r.symbol, side: r.side, qty: r.qty, entryPrice: r.entry_price, entryTime: r.entry_time }));
    const orbOpen: OrbOpenPosition[] = [];
    const pairsOpen: OpenLeg[] = openRows
      .filter((r) => r.strategy_id === PAIRS_STRATEGY_ID && r.pair_key)
      .map((r) => ({ id: r.id, pairKey: r.pair_key!, symbol: r.symbol, side: r.side, qty: r.qty, entryPrice: r.entry_price }));

    // --- ORB: carica stop/target dallo stato salvato insieme alla posizione (lab_state) ---
    const orbStopTargets = (await getCachedState<Record<number, { stop: number; target: number }>>(
      ORB_STRATEGY_ID,
      tradingDate,
      "stop_targets"
    )) ?? {};
    for (const r of openRows.filter((r) => r.strategy_id === ORB_STRATEGY_ID)) {
      const st = orbStopTargets[r.id];
      orbOpen.push({
        id: r.id,
        symbol: r.symbol,
        side: r.side,
        qty: r.qty,
        entryPrice: r.entry_price,
        stopPrice: st?.stop ?? r.entry_price,
        targetPrice: st?.target ?? r.entry_price,
      });
    }

    const vwapSnapshots: Record<string, VwapSnapshot> = {};
    for (const [symbol, s] of Object.entries(snapshots)) vwapSnapshots[symbol] = { price: s.price, vwap: s.vwap };
    const vwapBars: Record<string, { t: string; c: number }[]> = {};
    for (const symbol of UNIVERSE_SYMBOLS) vwapBars[symbol] = sessionBars[symbol].map((b) => ({ t: b.t, c: b.c }));

    const vwapExits = decideVwapExits(vwapOpen, vwapSnapshots, now);
    const orbExits = decideOrbExits(orbOpen, prices);

    // --- ORB: range di apertura e ATR, calcolati una volta al giorno e messi in cache ---
    let openingRanges = (await getCachedState<Record<string, OpeningRange>>(ORB_STRATEGY_ID, tradingDate, "opening_range")) ?? {};
    if (Object.keys(openingRanges).length === 0) {
      const computed: Record<string, OpeningRange> = {};
      for (const symbol of UNIVERSE_SYMBOLS) {
        const range = computeOpeningRange(sessionBars[symbol].map((b) => ({ h: b.h, l: b.l })));
        if (range) computed[symbol] = range;
      }
      if (Object.keys(computed).length > 0) {
        await setCachedState(ORB_STRATEGY_ID, tradingDate, "opening_range", computed);
        openingRanges = computed;
      }
    }

    let orbAtr = (await getCachedState<Record<string, number>>(ORB_STRATEGY_ID, tradingDate, "atr")) ?? {};
    let pairStats = (await getCachedState<PairStats[]>(PAIRS_STRATEGY_ID, tradingDate, "pair_stats")) ?? [];
    if (Object.keys(orbAtr).length === 0 || pairStats.length === 0) {
      const dailyBars = await fetchDailyBars(90);
      if (Object.keys(orbAtr).length === 0) {
        const computed: Record<string, number> = {};
        for (const symbol of UNIVERSE_SYMBOLS) {
          const atr = computeATRPct(dailyBars[symbol]);
          if (atr != null) computed[symbol] = atr;
        }
        await setCachedState(ORB_STRATEGY_ID, tradingDate, "atr", computed);
        orbAtr = computed;
      }
      if (pairStats.length === 0) {
        const closesBySymbol: Record<string, number[]> = {};
        for (const symbol of UNIVERSE_SYMBOLS) closesBySymbol[symbol] = dailyBars[symbol].map((b) => b.c);
        pairStats = selectPairs(closesBySymbol);
        await setCachedState(PAIRS_STRATEGY_ID, tradingDate, "pair_stats", pairStats);
      }
    }

    const pairStatsByKey: Record<string, PairStats> = {};
    for (const p of pairStats) pairStatsByKey[pairKey(p.a, p.b)] = p;
    const pairsExits = decidePairsExits(pairsOpen, prices, pairStatsByKey);

    // Applica le uscite di ogni strategia.
    for (const exit of vwapExits) {
      await db()`UPDATE lab_positions SET status='closed', exit_price=${exit.exitPrice}, exit_time=${now.toISOString()}, realized_pnl=${exit.realizedPnl} WHERE id=${exit.position.id}`;
    }
    for (const exit of orbExits) {
      await db()`UPDATE lab_positions SET status='closed', exit_price=${exit.exitPrice}, exit_time=${now.toISOString()}, realized_pnl=${exit.realizedPnl} WHERE id=${exit.position.id}`;
    }
    for (const exit of pairsExits) {
      for (const legId of exit.legIds) {
        const leg = pairsOpen.find((l) => l.id === legId);
        const price = leg ? prices[leg.symbol] : undefined;
        if (!leg || price == null) continue;
        const dir = leg.side === "LONG" ? 1 : -1;
        const legPnl = Math.round(leg.qty * (price - leg.entryPrice) * dir);
        await db()`UPDATE lab_positions SET status='closed', exit_price=${price}, exit_time=${now.toISOString()}, realized_pnl=${legPnl} WHERE id=${legId}`;
      }
    }

    const entriesSummary = { vwap: 0, orb: 0, pairs: 0 };
    if (!nearClose) {
      const vwapStillOpen = new Set(vwapOpen.filter((p) => !vwapExits.some((e) => e.position.id === p.id)).map((p) => p.symbol));
      const vwapEntries = decideVwapEntries(UNIVERSE_SYMBOLS, vwapStillOpen, vwapSnapshots, vwapBars, VWAP_MAX_POSITIONS - vwapStillOpen.size);
      for (const e of vwapEntries) {
        await db()`INSERT INTO lab_positions (strategy_id, symbol, side, qty, entry_price, entry_time, status) VALUES (${VWAP_STRATEGY_ID}, ${e.symbol}, ${e.side}, ${e.qty}, ${e.entryPrice}, ${now.toISOString()}, 'open')`;
      }
      entriesSummary.vwap = vwapEntries.length;

      const orbStillOpenSymbols = new Set(orbOpen.filter((p) => !orbExits.some((e) => e.position.id === p.id)).map((p) => p.symbol));
      const orbInputs: Record<string, OrbEntryInputs> = {};
      for (const symbol of UNIVERSE_SYMBOLS) {
        const range = openingRanges[symbol];
        const atr = orbAtr[symbol];
        const bars = sessionBars[symbol];
        const price = prices[symbol];
        if (!range || atr == null || bars.length === 0 || price == null) continue;
        const avgVol = bars.reduce((s, b) => s + b.v, 0) / bars.length;
        orbInputs[symbol] = { price, openingRange: range, atrPct: atr, avgBarVolume: avgVol, latestBarVolume: bars[bars.length - 1].v };
      }
      const orbEntries = decideOrbEntries(UNIVERSE_SYMBOLS, orbStillOpenSymbols, orbInputs, ORB_MAX_POSITIONS - orbStillOpenSymbols.size);
      const newStopTargets: Record<number, { stop: number; target: number }> = { ...orbStopTargets };
      for (const e of orbEntries) {
        const rows = (await db()`
          INSERT INTO lab_positions (strategy_id, symbol, side, qty, entry_price, entry_time, status)
          VALUES (${ORB_STRATEGY_ID}, ${e.symbol}, ${e.side}, ${e.qty}, ${e.entryPrice}, ${now.toISOString()}, 'open')
          RETURNING id
        `) as unknown as { id: number }[];
        const id = rows[0]?.id;
        if (id != null) newStopTargets[id] = { stop: e.stopPrice, target: e.targetPrice };
      }
      if (orbEntries.length > 0) await setCachedState(ORB_STRATEGY_ID, tradingDate, "stop_targets", newStopTargets);
      entriesSummary.orb = orbEntries.length;

      const pairsStillOpenKeys = new Set(
        pairsOpen.filter((leg) => !pairsExits.some((e) => e.legIds.includes(leg.id))).map((leg) => leg.pairKey)
      );
      const pairsEntries = decidePairsEntries(pairStats, pairsStillOpenKeys, prices, MAX_PAIRS - pairsStillOpenKeys.size);
      for (const e of pairsEntries) {
        for (const leg of e.legs) {
          await db()`
            INSERT INTO lab_positions (strategy_id, symbol, side, qty, entry_price, entry_time, status, pair_key)
            VALUES (${PAIRS_STRATEGY_ID}, ${leg.symbol}, ${leg.side}, ${leg.qty}, ${leg.entryPrice}, ${now.toISOString()}, 'open', ${e.pairKey})
          `;
        }
      }
      entriesSummary.pairs = pairsEntries.length;
    }

    // --- Rete di sicurezza EOD: chiude qualunque posizione lab ancora aperta e in utile, a ridosso della chiusura ---
    let eodClosedCount = 0;
    if (nearClose) {
      const stillOpenIds = new Set([...vwapExits, ...orbExits].map((e) => e.position.id));
      for (const e of pairsExits) for (const id of e.legIds) stillOpenIds.add(id);
      const remaining: LabOpenRow[] = openRows
        .filter((r) => !stillOpenIds.has(r.id))
        .map((r) => ({ id: r.id, symbol: r.symbol, side: r.side, qty: r.qty, entryPrice: r.entry_price }));
      const eodCloses = decideLabEodCloses(remaining, prices);
      for (const c of eodCloses) {
        await db()`UPDATE lab_positions SET status='closed', exit_price=${c.exitPrice}, exit_time=${now.toISOString()}, realized_pnl=${c.realizedPnl} WHERE id=${c.id}`;
      }
      eodClosedCount = eodCloses.length;
    }

    const note = `vwap: ${vwapExits.length} chiuse/${entriesSummary.vwap} aperte · orb: ${orbExits.length} chiuse/${entriesSummary.orb} aperte · pairs: ${pairsExits.length} chiuse/${entriesSummary.pairs} aperte${nearClose ? ` · EOD: ${eodClosedCount} chiuse` : ""}`;
    await db()`INSERT INTO tick_log (market_open, note) VALUES (true, ${note})`;

    res.status(200).json({ marketOpen: true, nearClose, note, entriesSummary, eodClosedCount });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}

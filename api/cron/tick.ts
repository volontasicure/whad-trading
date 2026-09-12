import type { VercelRequest, VercelResponse } from "@vercel/node";
import { alpacaDataFetch, alpacaFetch } from "../../server/alpaca.js";
import { db } from "../../server/db.js";
import { UNIVERSE_SYMBOLS } from "../../server/universe.js";
import { decideLabEodCloses, type LabOpenRow } from "../../server/labEod.js";
import { fetchMarketSession } from "../../server/marketHours.js";
import { saveDailyBars, saveSessionBars } from "../../server/barsStore.js";
import {
  MAX_POSITIONS as ORB_MAX_POSITIONS,
  STRATEGY_ID as ORB_STRATEGY_ID,
  computeATRPct,
  computeOpeningRange,
  decideEntries as decideOrbEntries,
  decideExits as decideOrbExits,
  type EntryInputs as OrbEntryInputs,
  type OpenPosition as OrbOpenPosition,
  type OpeningRange,
} from "../../server/orb.js";
import {
  MAX_PAIRS,
  STRATEGY_ID as PAIRS_STRATEGY_ID,
  decideEntries as decidePairsEntries,
  decideExits as decidePairsExits,
  decidePairsEodCloses,
  pairKey,
  selectPairs,
  statsForPair,
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
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface AlpacaIntradayBarRaw {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vw: number;
}

async function fetchPrices(): Promise<Record<string, number>> {
  const symbols = UNIVERSE_SYMBOLS.join(",");
  const raw = await alpacaDataFetch<Record<string, AlpacaSnapshotRaw>>(
    `/v2/stocks/snapshots?symbols=${encodeURIComponent(symbols)}&feed=iex`
  );
  const out: Record<string, number> = {};
  for (const symbol of UNIVERSE_SYMBOLS) {
    const s = raw[symbol];
    const price = s?.latestTrade?.p ?? s?.dailyBar?.c;
    if (price != null) out[symbol] = price;
  }
  return out;
}

/**
 * Barre a 5 min della sola sessione regolare di oggi (9:30-16:00 ET, mai pre/post market).
 * Usa il calendario reale di Alpaca per il confine esatto — un fetch da "mezzanotte UTC"
 * includeva erroneamente le barre pre-market (dalle 4:00 ET), falsando sia il range di
 * apertura ORB sia il VWAP di giornata. Bug trovato col backtest prima del primo giorno live.
 */
async function fetchTodaySessionBars(now: Date, sessionOpenUtc: string): Promise<Record<string, AlpacaIntradayBarRaw[]>> {
  const symbols = UNIVERSE_SYMBOLS.join(",");
  const raw = await alpacaDataFetch<{ bars?: Record<string, AlpacaIntradayBarRaw[]> }>(
    `/v2/stocks/bars?symbols=${encodeURIComponent(symbols)}&timeframe=5Min&limit=3000&feed=iex&sort=asc&start=${encodeURIComponent(sessionOpenUtc)}&end=${encodeURIComponent(now.toISOString())}`
  );
  const out: Record<string, AlpacaIntradayBarRaw[]> = {};
  for (const symbol of UNIVERSE_SYMBOLS) out[symbol] = raw.bars?.[symbol] ?? [];
  return out;
}

/** Non deve mai bloccare/rompere il tick: la persistenza storica è un di più, non trading logic. */
async function persistBarsBestEffort(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`persistenza barre (${label}) fallita, proseguo comunque:`, (err as Error).message);
  }
}

function sessionVWAP(bars: AlpacaIntradayBarRaw[]): number | null {
  const totalVol = bars.reduce((s, b) => s + b.v, 0);
  if (totalVol === 0) return null;
  return bars.reduce((s, b) => s + b.vw * b.v, 0) / totalVol;
}

async function fetchDailyBars(days: number): Promise<Record<string, AlpacaDailyBarRaw[]>> {
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const symbols = UNIVERSE_SYMBOLS.join(",");
  const raw = await alpacaDataFetch<{ bars?: Record<string, AlpacaDailyBarRaw[]> }>(
    `/v2/stocks/bars?symbols=${encodeURIComponent(symbols)}&timeframe=1Day&limit=10000&feed=iex&sort=asc&start=${encodeURIComponent(start)}`
  );
  const out: Record<string, AlpacaDailyBarRaw[]> = {};
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
  stop_price: number | null;
  target_price: number | null;
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

    const session = await fetchMarketSession(tradingDate);
    if (!session) {
      // Non dovrebbe succedere se clock.is_open è true, ma niente sessione valida = niente da fare.
      await db()`INSERT INTO tick_log (market_open, note) VALUES (true, 'calendario Alpaca senza sessione per oggi, salto')`;
      res.status(200).json({ marketOpen: true, note: "nessuna sessione trovata nel calendario" });
      return;
    }

    const [prices, sessionBars, openRows] = await Promise.all([
      fetchPrices(),
      fetchTodaySessionBars(now, session.openUtc),
      db()`
        SELECT id, strategy_id, symbol, side, qty::float8 AS qty, entry_price::float8 AS entry_price, entry_time,
               pair_key, stop_price::float8 AS stop_price, target_price::float8 AS target_price
        FROM lab_positions WHERE status = 'open'
      ` as unknown as Promise<LabPositionRow[]>,
    ]);

    const vwapOpen: VwapOpenPosition[] = openRows
      .filter((r) => r.strategy_id === VWAP_STRATEGY_ID)
      .map((r) => ({ id: r.id, symbol: r.symbol, side: r.side, qty: r.qty, entryPrice: r.entry_price, entryTime: r.entry_time }));
    // Stop/target vivono sulla riga (non in una cache per data): una posizione ORB che
    // sopravvive oltre la giornata in cui è stata aperta non li perde mai. Il fallback al
    // prezzo di ingresso resta solo per righe pre-esistenti create prima di queste colonne.
    const orbOpen: OrbOpenPosition[] = openRows
      .filter((r) => r.strategy_id === ORB_STRATEGY_ID)
      .map((r) => ({
        id: r.id,
        symbol: r.symbol,
        side: r.side,
        qty: r.qty,
        entryPrice: r.entry_price,
        stopPrice: r.stop_price ?? r.entry_price,
        targetPrice: r.target_price ?? r.entry_price,
      }));
    const pairsOpen: OpenLeg[] = openRows
      .filter((r) => r.strategy_id === PAIRS_STRATEGY_ID && r.pair_key)
      .map((r) => ({ id: r.id, pairKey: r.pair_key!, symbol: r.symbol, side: r.side, qty: r.qty, entryPrice: r.entry_price }));

    const vwapSnapshots: Record<string, VwapSnapshot> = {};
    for (const symbol of UNIVERSE_SYMBOLS) {
      const price = prices[symbol];
      const vwap = sessionVWAP(sessionBars[symbol]);
      if (price != null && vwap != null) vwapSnapshots[symbol] = { price, vwap };
    }
    const vwapBars: Record<string, { t: string; c: number }[]> = {};
    for (const symbol of UNIVERSE_SYMBOLS) vwapBars[symbol] = sessionBars[symbol].map((b) => ({ t: b.t, c: b.c }));

    await persistBarsBestEffort("session_bars", () =>
      saveSessionBars(
        UNIVERSE_SYMBOLS.flatMap((symbol) =>
          sessionBars[symbol].map((b) => ({
            symbol,
            barTime: b.t,
            open: b.o,
            high: b.h,
            low: b.l,
            close: b.c,
            volume: b.v,
            vwap: b.vw,
          }))
        )
      )
    );

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

    const openPairKeys = new Set(pairsOpen.map((l) => l.pairKey));
    const coversAllOpenPairs = (stats: PairStats[]) =>
      [...openPairKeys].every((k) => stats.some((p) => pairKey(p.a, p.b) === k));

    let orbAtr = (await getCachedState<Record<string, number>>(ORB_STRATEGY_ID, tradingDate, "atr")) ?? {};
    let pairStats = (await getCachedState<PairStats[]>(PAIRS_STRATEGY_ID, tradingDate, "pair_stats")) ?? [];
    if (Object.keys(orbAtr).length === 0 || pairStats.length === 0 || !coversAllOpenPairs(pairStats)) {
      const dailyBars = await fetchDailyBars(90);
      const closesBySymbol: Record<string, number[]> = {};
      for (const symbol of UNIVERSE_SYMBOLS) closesBySymbol[symbol] = dailyBars[symbol].map((b) => b.c);

      await persistBarsBestEffort("daily_bars", () =>
        saveDailyBars(
          UNIVERSE_SYMBOLS.flatMap((symbol) =>
            dailyBars[symbol].map((b) => ({
              symbol,
              tradingDate: b.t.slice(0, 10),
              open: b.o,
              high: b.h,
              low: b.l,
              close: b.c,
              volume: b.v,
            }))
          )
        )
      );

      if (Object.keys(orbAtr).length === 0) {
        const computed: Record<string, number> = {};
        for (const symbol of UNIVERSE_SYMBOLS) {
          const atr = computeATRPct(dailyBars[symbol]);
          if (atr != null) computed[symbol] = atr;
        }
        await setCachedState(ORB_STRATEGY_ID, tradingDate, "atr", computed);
        orbAtr = computed;
      }

      if (pairStats.length === 0) pairStats = selectPairs(closesBySymbol);
      // Una coppia con posizione aperta deve restare valutabile per l'uscita anche se oggi
      // non rientra più tra le MAX_PAIRS più correlate — altrimenti resterebbe aperta per
      // sempre, "dimenticata", non appena la selezione giornaliera cambia.
      for (const key of openPairKeys) {
        if (pairStats.some((p) => pairKey(p.a, p.b) === key)) continue;
        const [a, b] = key.split("/");
        const stats = statsForPair(a, b, closesBySymbol);
        if (stats) pairStats.push(stats);
      }
      await setCachedState(PAIRS_STRATEGY_ID, tradingDate, "pair_stats", pairStats);
    }

    const pairStatsByKey: Record<string, PairStats> = {};
    for (const p of pairStats) pairStatsByKey[pairKey(p.a, p.b)] = p;
    const pairsExits = decidePairsExits(pairsOpen, prices, pairStatsByKey);

    // Raffreddamento post-stop: una coppia il cui z-score resta stabilmente oltre STOP_Z
    // (relazione rotta per davvero, non rumore) va altrimenti in stop e rientra al tick
    // successivo all'infinito — trovato con un backtest su dati storici reali (46 stop in
    // un solo giorno sulla stessa coppia). Chi è uscita in stop oggi non rientra più oggi.
    let stoppedPairsToday = (await getCachedState<string[]>(PAIRS_STRATEGY_ID, tradingDate, "stopped_today")) ?? [];
    const newlyStopped = pairsExits.filter((e) => e.reason === "stop").map((e) => e.pairKey);
    if (newlyStopped.length > 0) {
      const merged = new Set([...stoppedPairsToday, ...newlyStopped]);
      if (merged.size > stoppedPairsToday.length) {
        stoppedPairsToday = [...merged];
        await setCachedState(PAIRS_STRATEGY_ID, tradingDate, "stopped_today", stoppedPairsToday);
      }
    }

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
      for (const e of orbEntries) {
        await db()`
          INSERT INTO lab_positions (strategy_id, symbol, side, qty, entry_price, entry_time, status, stop_price, target_price)
          VALUES (${ORB_STRATEGY_ID}, ${e.symbol}, ${e.side}, ${e.qty}, ${e.entryPrice}, ${now.toISOString()}, 'open', ${e.stopPrice}, ${e.targetPrice})
        `;
      }
      entriesSummary.orb = orbEntries.length;

      const pairsStillOpenKeys = new Set(
        pairsOpen.filter((leg) => !pairsExits.some((e) => e.legIds.includes(leg.id))).map((leg) => leg.pairKey)
      );
      const pairsExcludedKeys = new Set([...pairsStillOpenKeys, ...stoppedPairsToday]);
      const pairsEntries = decidePairsEntries(pairStats, pairsExcludedKeys, prices, MAX_PAIRS - pairsStillOpenKeys.size);
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
    // Le coppie sono gestite separatamente (decidePairsEodCloses): le due gambe si chiudono
    // insieme solo se il P&L combinato è positivo, mai una gamba sola — altrimenti quella
    // rimasta resta orfana e nessuna logica la riprende più in mano (bug trovato con un
    // backtest su dati storici reali prima del primo giorno live).
    let eodClosedCount = 0;
    if (nearClose) {
      const stillOpenIds = new Set([...vwapExits, ...orbExits].map((e) => e.position.id));
      for (const e of pairsExits) for (const id of e.legIds) stillOpenIds.add(id);
      const remainingRows = openRows.filter((r) => !stillOpenIds.has(r.id));

      const singleRows: LabOpenRow[] = remainingRows
        .filter((r) => !r.pair_key)
        .map((r) => ({ id: r.id, symbol: r.symbol, side: r.side, qty: r.qty, entryPrice: r.entry_price }));
      const singleCloses = decideLabEodCloses(singleRows, prices);
      for (const c of singleCloses) {
        await db()`UPDATE lab_positions SET status='closed', exit_price=${c.exitPrice}, exit_time=${now.toISOString()}, realized_pnl=${c.realizedPnl} WHERE id=${c.id}`;
      }

      const pairLegRows: OpenLeg[] = remainingRows
        .filter((r) => r.pair_key)
        .map((r) => ({ id: r.id, pairKey: r.pair_key!, symbol: r.symbol, side: r.side, qty: r.qty, entryPrice: r.entry_price }));
      const pairEodCloses = decidePairsEodCloses(pairLegRows, prices);
      let pairLegsClosed = 0;
      for (const pc of pairEodCloses) {
        for (const legId of pc.legIds) {
          const leg = pairLegRows.find((l) => l.id === legId);
          const price = leg ? prices[leg.symbol] : undefined;
          if (!leg || price == null) continue;
          const dir = leg.side === "LONG" ? 1 : -1;
          const legPnl = Math.round(leg.qty * (price - leg.entryPrice) * dir);
          await db()`UPDATE lab_positions SET status='closed', exit_price=${price}, exit_time=${now.toISOString()}, realized_pnl=${legPnl} WHERE id=${legId}`;
          pairLegsClosed++;
        }
      }

      eodClosedCount = singleCloses.length + pairLegsClosed;
    }

    const note = `vwap: ${vwapExits.length} chiuse/${entriesSummary.vwap} aperte · orb: ${orbExits.length} chiuse/${entriesSummary.orb} aperte · pairs: ${pairsExits.length} chiuse/${entriesSummary.pairs} aperte${nearClose ? ` · EOD: ${eodClosedCount} chiuse` : ""}`;
    await db()`INSERT INTO tick_log (market_open, note) VALUES (true, ${note})`;

    res.status(200).json({ marketOpen: true, nearClose, note, entriesSummary, eodClosedCount });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}

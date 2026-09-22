import type { VercelRequest, VercelResponse } from "@vercel/node";
import { alpacaDataFetch, alpacaFetch } from "../../server/alpaca.js";
import { db } from "../../server/db.js";
import { UNIVERSE_SYMBOLS } from "../../server/universe.js";
import { decideLabEodCloses, type LabOpenRow } from "../../server/labEod.js";
import { fetchMarketSession } from "../../server/marketHours.js";
import { saveDailyBars, saveSessionBars } from "../../server/barsStore.js";
import { runRealExecution, type RealPositionRow } from "../../server/realExecution.js";
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
  currentZ,
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
  TREND_FILTER_DAYS as VWAP_TREND_FILTER_DAYS,
  decideEntries as decideVwapEntries,
  decideExits as decideVwapExits,
  type OpenPosition as VwapOpenPosition,
  type Snapshot as VwapSnapshot,
  type TrendContext as VwapTrendContext,
} from "../../server/vwapReversion.js";
import { computeSMA, computeTrendEfficiency } from "../../server/technicalIndicators.js";

const EOD_CLOSE_WINDOW_MINUTES = 20;
// Guard contro esecuzioni troppo ravvicinate: protegge sia da un TICK_SECRET trapelato
// (repo pubblico, un secret condiviso che finisse in un log/commit permetterebbe a chiunque
// di richiamare l'endpoint) sia da un bug di concorrenza reale — due esecuzioni sovrapposte
// non hanno alcun lock a livello di database e potrebbero decidere entrambe di aprire la
// stessa posizione. Il blocco concurrency in tick.yml protegge solo dalle nostre esecuzioni
// GitHub Actions; questo protegge anche da chi chiamasse l'endpoint Vercel direttamente.
// 60s è ben sotto la cadenza normale di 5 minuti, quindi non interferisce mai in condizioni
// normali.
const MIN_TICK_INTERVAL_MS = 60_000;

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
 * Con molti simboli e molti giorni la risposta multi-simbolo di Alpaca non entra in una
 * sola pagina: torna solo un sottoinsieme di simboli/barre più un next_page_token. Senza
 * seguire la paginazione fino in fondo, metà dei simboli risultano silenziosamente senza
 * barre — scoperto allargando l'universo da 20 a 40 titoli (prima, con 20, capitava sempre
 * in una pagina sola).
 */
async function fetchBarsPaginated<T>(basePath: string): Promise<Record<string, T[]>> {
  const merged: Record<string, T[]> = {};
  let pageToken: string | null = null;
  for (;;) {
    const path: string = basePath + (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : "");
    const raw: { bars?: Record<string, T[]>; next_page_token?: string | null } = await alpacaDataFetch(path);
    for (const [symbol, bars] of Object.entries(raw.bars ?? {})) {
      (merged[symbol] ??= []).push(...bars);
    }
    pageToken = raw.next_page_token ?? null;
    if (!pageToken) break;
  }
  return merged;
}

/**
 * Barre a 5 min della sola sessione regolare di oggi (9:30-16:00 ET, mai pre/post market).
 * Usa il calendario reale di Alpaca per il confine esatto — un fetch da "mezzanotte UTC"
 * includeva erroneamente le barre pre-market (dalle 4:00 ET), falsando sia il range di
 * apertura ORB sia il VWAP di giornata. Bug trovato col backtest prima del primo giorno live.
 */
async function fetchTodaySessionBars(now: Date, sessionOpenUtc: string): Promise<Record<string, AlpacaIntradayBarRaw[]>> {
  const symbols = UNIVERSE_SYMBOLS.join(",");
  const merged = await fetchBarsPaginated<AlpacaIntradayBarRaw>(
    `/v2/stocks/bars?symbols=${encodeURIComponent(symbols)}&timeframe=5Min&limit=3000&feed=iex&sort=asc&start=${encodeURIComponent(sessionOpenUtc)}&end=${encodeURIComponent(now.toISOString())}`
  );
  const out: Record<string, AlpacaIntradayBarRaw[]> = {};
  for (const symbol of UNIVERSE_SYMBOLS) out[symbol] = merged[symbol] ?? [];
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
  const merged = await fetchBarsPaginated<AlpacaDailyBarRaw>(
    `/v2/stocks/bars?symbols=${encodeURIComponent(symbols)}&timeframe=1Day&limit=10000&feed=iex&sort=asc&start=${encodeURIComponent(start)}`
  );
  const out: Record<string, AlpacaDailyBarRaw[]> = {};
  for (const symbol of UNIVERSE_SYMBOLS) out[symbol] = merged[symbol] ?? [];
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
    const lastRunRows = (await db()`
      SELECT ran_at FROM tick_log ORDER BY ran_at DESC LIMIT 1
    `) as unknown as { ran_at: string }[];
    if (lastRunRows.length > 0) {
      const sinceLastMs = Date.now() - new Date(lastRunRows[0].ran_at).getTime();
      if (sinceLastMs < MIN_TICK_INTERVAL_MS) {
        res.status(429).json({ error: `Esecuzione troppo ravvicinata: ultima ${Math.round(sinceLastMs / 1000)}s fa (minimo ${MIN_TICK_INTERVAL_MS / 1000}s)` });
        return;
      }
    }

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

    const [prices, sessionBars, openRows, realOpenRows] = await Promise.all([
      fetchPrices(),
      fetchTodaySessionBars(now, session.openUtc),
      db()`
        SELECT id, strategy_id, symbol, side, qty::float8 AS qty, entry_price::float8 AS entry_price, entry_time,
               pair_key, stop_price::float8 AS stop_price, target_price::float8 AS target_price
        FROM lab_positions WHERE status = 'open'
      ` as unknown as Promise<LabPositionRow[]>,
      db()`
        SELECT id, strategy_id, symbol, side, qty::float8 AS qty, entry_price::float8 AS entry_price, entry_time,
               pair_key, stop_price::float8 AS stop_price, target_price::float8 AS target_price
        FROM real_positions WHERE status = 'open'
      ` as unknown as Promise<RealPositionRow[]>,
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
    // Pair key delle posizioni PAIRS reali aperte: devono restare coperte dal refresh dei
    // pairStats sotto esattamente come quelle dei lab, altrimenti una coppia reale rimasta
    // fuori dalla selezione giornaliera non verrebbe più valutata per l'uscita.
    const realPairsOpenKeys = new Set(
      realOpenRows.filter((r) => r.strategy_id === PAIRS_STRATEGY_ID && r.pair_key).map((r) => r.pair_key!)
    );

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

    const openPairKeys = new Set([...pairsOpen.map((l) => l.pairKey), ...realPairsOpenKeys]);
    const coversAllOpenPairs = (stats: PairStats[]) =>
      [...openPairKeys].every((k) => stats.some((p) => pairKey(p.a, p.b) === k));

    let orbAtr = (await getCachedState<Record<string, number>>(ORB_STRATEGY_ID, tradingDate, "atr")) ?? {};
    let vwapTrend = (await getCachedState<Record<string, VwapTrendContext>>(VWAP_STRATEGY_ID, tradingDate, "trend")) ?? {};
    let pairStats = (await getCachedState<PairStats[]>(PAIRS_STRATEGY_ID, tradingDate, "pair_stats")) ?? [];
    if (Object.keys(orbAtr).length === 0 || Object.keys(vwapTrend).length === 0 || pairStats.length === 0 || !coversAllOpenPairs(pairStats)) {
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

      if (Object.keys(vwapTrend).length === 0) {
        const computed: Record<string, VwapTrendContext> = {};
        for (const symbol of UNIVERSE_SYMBOLS) {
          const sma = computeSMA(closesBySymbol[symbol], VWAP_TREND_FILTER_DAYS);
          const efficiency = computeTrendEfficiency(closesBySymbol[symbol], VWAP_TREND_FILTER_DAYS);
          if (sma != null && efficiency != null) computed[symbol] = { sma, efficiency };
        }
        await setCachedState(VWAP_STRATEGY_ID, tradingDate, "trend", computed);
        vwapTrend = computed;
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

    // Diagnostica: z-score di ogni coppia candidata del giorno, non solo quelle che entrano —
    // senza questo un giorno senza nuovi ingressi non distingue "soglia sfiorata" da "coppie
    // poco correlate". Best-effort: non deve mai bloccare il tick.
    await persistBarsBestEffort("pairs_zscore", async () => {
      await Promise.all(
        pairStats.map(async (p) => {
          const priceA = prices[p.a];
          const priceB = prices[p.b];
          if (priceA == null || priceB == null) return;
          const z = currentZ(priceA, priceB, p);
          if (z == null) return;
          await db()`
            INSERT INTO pairs_zscore_log (trading_date, pair_key, symbol_a, symbol_b, z)
            VALUES (${tradingDate}, ${pairKey(p.a, p.b)}, ${p.a}, ${p.b}, ${z})
          `;
        })
      );
    });

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
      await db()`UPDATE lab_positions SET status='closed', exit_price=${exit.exitPrice}, exit_time=${now.toISOString()}, realized_pnl=${exit.realizedPnl}, exit_reason=${exit.reason} WHERE id=${exit.position.id}`;
    }
    for (const exit of orbExits) {
      await db()`UPDATE lab_positions SET status='closed', exit_price=${exit.exitPrice}, exit_time=${now.toISOString()}, realized_pnl=${exit.realizedPnl}, exit_reason=${exit.reason} WHERE id=${exit.position.id}`;
    }
    for (const exit of pairsExits) {
      for (const legId of exit.legIds) {
        const leg = pairsOpen.find((l) => l.id === legId);
        const price = leg ? prices[leg.symbol] : undefined;
        if (!leg || price == null) continue;
        const dir = leg.side === "LONG" ? 1 : -1;
        const legPnl = Math.round(leg.qty * (price - leg.entryPrice) * dir);
        await db()`UPDATE lab_positions SET status='closed', exit_price=${price}, exit_time=${now.toISOString()}, realized_pnl=${legPnl}, exit_reason=${exit.reason} WHERE id=${legId}`;
      }
    }

    const entriesSummary = { vwap: 0, orb: 0, pairs: 0 };
    if (!nearClose) {
      const vwapStillOpen = new Set(vwapOpen.filter((p) => !vwapExits.some((e) => e.position.id === p.id)).map((p) => p.symbol));
      // vwapTrend calcolato sopra ma NON passato qui apposta: il filtro di trend è pronto ma
      // tenuto spento in produzione finché non viene deciso esplicitamente di attivarlo (vedi
      // CLAUDE.md "Prossimi passi" #9 — backtest con segnale misto, non generalizza fuori
      // campione). Riattivare aggiungendo `, vwapTrend` qui e nella chiamata gemella in
      // server/realExecution.ts.
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

    // --- Rete di sicurezza EOD, a ridosso della chiusura ---
    // ORB/VWAP (posizioni singole, decideLabEodCloses): chiude sempre, in utile o in perdita
    // (dal 22/9/2026, vedi server/labEod.ts per l'evidenza da backtest). Pairs
    // (decidePairsEodCloses): resta la regola precedente, le due gambe si chiudono insieme
    // solo se il P&L combinato è positivo, mai una gamba sola — altrimenti quella rimasta
    // resta orfana e nessuna logica la riprende più in mano (bug trovato con un backtest su
    // dati storici reali prima del primo giorno live).
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
        await db()`UPDATE lab_positions SET status='closed', exit_price=${c.exitPrice}, exit_time=${now.toISOString()}, realized_pnl=${c.realizedPnl}, exit_reason='eod' WHERE id=${c.id}`;
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
          await db()`UPDATE lab_positions SET status='closed', exit_price=${price}, exit_time=${now.toISOString()}, realized_pnl=${legPnl}, exit_reason='eod' WHERE id=${legId}`;
          pairLegsClosed++;
        }
      }

      eodClosedCount = singleCloses.length + pairLegsClosed;
    }

    // --- Esecuzione reale (conto Alpaca, ambiente paper): solo se il debriefing di oggi è
    // stato confermato. Best-effort in senso stretto solo per l'isolamento dei tre lab sopra
    // — un problema qui non deve mai impedire di salvare il tick dei lab — ma un errore reale
    // (es. Alpaca irraggiungibile a metà invio ordini) resta comunque visibile in tick_log,
    // non silenziato.
    let realNote = "reale: non tentata";
    try {
      const sessionBarVolumes: Record<string, number[]> = {};
      for (const symbol of UNIVERSE_SYMBOLS) sessionBarVolumes[symbol] = sessionBars[symbol].map((b) => b.v);

      const realResult = await runRealExecution({
        tradingDate,
        now,
        nearClose,
        prices,
        openingRanges,
        orbAtr,
        vwapTrend,
        sessionBarVolumes,
        vwapSnapshots,
        vwapBars,
        pairStats,
        pairStatsByKey,
        stoppedPairsToday: new Set(stoppedPairsToday),
        openRows: realOpenRows,
      });
      realNote = realResult.skipped
        ? `reale: saltata (${realResult.reason})`
        : `reale: ${realResult.chosenStrategyId}, ${realResult.exits} chiuse/${realResult.entries} aperte${realResult.haltedByDailyLoss ? " (STOP GIORNALIERO: niente nuovi ingressi)" : ""}`;
    } catch (err) {
      realNote = `reale: errore (${(err as Error).message})`;
    }

    const note = `vwap: ${vwapExits.length} chiuse/${entriesSummary.vwap} aperte · orb: ${orbExits.length} chiuse/${entriesSummary.orb} aperte · pairs: ${pairsExits.length} chiuse/${entriesSummary.pairs} aperte${nearClose ? ` · EOD: ${eodClosedCount} chiuse` : ""} · ${realNote}`;
    await db()`INSERT INTO tick_log (market_open, note) VALUES (true, ${note})`;

    res.status(200).json({ marketOpen: true, nearClose, note, entriesSummary, eodClosedCount });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { alpacaDataFetch } from "../../server/alpaca.js";
import { UNIVERSE_SYMBOLS } from "../../server/universe.js";
import { decideLabEodCloses, type LabOpenRow } from "../../server/labEod.js";
import {
  ATR_THRESHOLD_PCT as ORB_ATR,
  MAX_POSITIONS as ORB_MAX,
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
  decideEntries as decidePairsEntries,
  decideExits as decidePairsExits,
  pairKey,
  selectPairs,
  type OpenLeg,
  type PairStats,
} from "../../server/pairsTrading.js";
import {
  MAX_POSITIONS as VWAP_MAX,
  decideEntries as decideVwapEntries,
  decideExits as decideVwapExits,
  type OpenPosition as VwapOpenPosition,
  type Snapshot as VwapSnapshot,
} from "../../server/vwapReversion.js";

interface RawBar {
  t: string;
  h: number;
  l: number;
  c: number;
  v: number;
  vw: number;
}

async function fetchDayBars(dateIso: string): Promise<Record<string, RawBar[]>> {
  const start = `${dateIso}T00:00:00Z`;
  const end = `${dateIso}T23:59:59Z`;
  const symbols = UNIVERSE_SYMBOLS.join(",");
  const raw = await alpacaDataFetch<{ bars?: Record<string, RawBar[]> }>(
    `/v2/stocks/bars?symbols=${encodeURIComponent(symbols)}&timeframe=5Min&limit=3000&feed=iex&sort=asc&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`
  );
  const out: Record<string, RawBar[]> = {};
  for (const s of UNIVERSE_SYMBOLS) out[s] = raw.bars?.[s] ?? [];
  return out;
}

async function fetchDailyBarsBefore(dateIso: string, days: number): Promise<Record<string, OrbDailyBar[]>> {
  const end = `${dateIso}T00:00:00Z`;
  const start = new Date(new Date(end).getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  const symbols = UNIVERSE_SYMBOLS.join(",");
  const raw = await alpacaDataFetch<{ bars?: Record<string, OrbDailyBar[]> }>(
    `/v2/stocks/bars?symbols=${encodeURIComponent(symbols)}&timeframe=1Day&limit=10000&feed=iex&sort=asc&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`
  );
  const out: Record<string, OrbDailyBar[]> = {};
  for (const s of UNIVERSE_SYMBOLS) out[s] = raw.bars?.[s] ?? [];
  return out;
}

function sessionVWAP(bars: RawBar[]): number | null {
  if (bars.length === 0) return null;
  const totalVol = bars.reduce((s, b) => s + b.v, 0);
  if (totalVol === 0) return null;
  return bars.reduce((s, b) => s + b.vw * b.v, 0) / totalVol;
}

let nextId = -1; // id negativi per non confondersi mai con righe vere del DB
function fakeId(): number {
  return nextId--;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = req.headers.authorization;
  if (!process.env.TICK_SECRET || auth !== `Bearer ${process.env.TICK_SECRET}`) {
    res.status(401).json({ error: "Non autorizzato" });
    return;
  }

  const date = typeof req.query.date === "string" ? req.query.date : "2026-09-11";
  const warnings: string[] = [];
  const trades: Record<string, unknown>[] = [];

  try {
    const [dayBars, dailyBarsHistory] = await Promise.all([fetchDayBars(date), fetchDailyBarsBefore(date, 90)]);

    const symbolsWithData = UNIVERSE_SYMBOLS.filter((s) => dayBars[s].length > 0);
    if (symbolsWithData.length === 0) {
      res.status(200).json({ error: `nessun dato per ${date} (festivo/weekend/fuori range?)`, warnings });
      return;
    }

    // Orario dei tick simulati: ogni 2 barre a 5 min (~10 minuti), sul calendario del simbolo con più barre.
    const clockSymbol = symbolsWithData.reduce((a, b) => (dayBars[b].length > dayBars[a].length ? b : a));
    const tickTimestamps = dayBars[clockSymbol].filter((_, i) => i % 2 === 0).map((b) => b.t);
    const sessionEnd = dayBars[clockSymbol][dayBars[clockSymbol].length - 1].t;

    // --- Indicatori calcolati una volta, come farebbe il primo tick della giornata ---
    const openingRanges: Record<string, OpeningRange> = {};
    const atrPct: Record<string, number> = {};
    for (const s of symbolsWithData) {
      const atr = computeATRPct(dailyBarsHistory[s]);
      if (atr != null) atrPct[s] = atr;
    }
    const closesBySymbol: Record<string, number[]> = {};
    for (const s of symbolsWithData) closesBySymbol[s] = dailyBarsHistory[s].map((b) => b.c);
    const pairStats: PairStats[] = selectPairs(closesBySymbol);
    const pairStatsByKey: Record<string, PairStats> = {};
    for (const p of pairStats) pairStatsByKey[pairKey(p.a, p.b)] = p;

    const vwapOpen: VwapOpenPosition[] = [];
    const orbOpen: OrbOpenPosition[] = [];
    const pairsOpen: OpenLeg[] = [];

    for (const t of tickTimestamps) {
      const barsSoFar: Record<string, RawBar[]> = {};
      for (const s of symbolsWithData) barsSoFar[s] = dayBars[s].filter((b) => b.t <= t);

      const prices: Record<string, number> = {};
      const vwapSnap: Record<string, VwapSnapshot> = {};
      for (const s of symbolsWithData) {
        const bars = barsSoFar[s];
        if (bars.length === 0) continue;
        const price = bars[bars.length - 1].c;
        prices[s] = price;
        const vwap = sessionVWAP(bars);
        if (vwap != null) vwapSnap[s] = { price, vwap };
      }

      for (const s of symbolsWithData) {
        if (openingRanges[s]) continue;
        const range = computeOpeningRange(barsSoFar[s].map((b) => ({ h: b.h, l: b.l })));
        if (range) openingRanges[s] = range;
      }

      const nowDate = new Date(t);
      const minutesToClose = (new Date(sessionEnd).getTime() - nowDate.getTime()) / 60_000;
      const nearClose = minutesToClose <= 20;

      const vwapExits = decideVwapExits(vwapOpen, vwapSnap, nowDate);
      const orbExits = decideOrbExits(orbOpen, prices);
      const pairsExits = decidePairsExits(pairsOpen, prices, pairStatsByKey);

      for (const e of vwapExits) {
        vwapOpen.splice(vwapOpen.indexOf(e.position), 1);
        trades.push({ t, strategy: "vwap_reversion", action: "exit", symbol: e.position.symbol, reason: e.reason, realizedPnl: e.realizedPnl });
        if (!Number.isFinite(e.realizedPnl)) warnings.push(`vwap exit realizedPnl non finito a ${t} su ${e.position.symbol}`);
      }
      for (const e of orbExits) {
        orbOpen.splice(orbOpen.indexOf(e.position), 1);
        trades.push({ t, strategy: "orb", action: "exit", symbol: e.position.symbol, reason: e.reason, realizedPnl: e.realizedPnl });
        if (!Number.isFinite(e.realizedPnl)) warnings.push(`orb exit realizedPnl non finito a ${t} su ${e.position.symbol}`);
      }
      for (const e of pairsExits) {
        for (const legId of e.legIds) {
          const idx = pairsOpen.findIndex((l) => l.id === legId);
          if (idx >= 0) pairsOpen.splice(idx, 1);
        }
        trades.push({ t, strategy: "pairs", action: "exit", pairKey: e.pairKey, reason: e.reason, realizedPnl: e.realizedPnl });
        if (!Number.isFinite(e.realizedPnl)) warnings.push(`pairs exit realizedPnl non finito a ${t} su ${e.pairKey}`);
      }

      if (!nearClose) {
        const vwapFree = VWAP_MAX - vwapOpen.length;
        const vwapBars: Record<string, { t: string; c: number }[]> = {};
        for (const s of symbolsWithData) vwapBars[s] = barsSoFar[s].map((b) => ({ t: b.t, c: b.c }));
        const vwapEntries = decideVwapEntries(symbolsWithData, new Set(vwapOpen.map((p) => p.symbol)), vwapSnap, vwapBars, vwapFree);
        for (const e of vwapEntries) {
          vwapOpen.push({ id: fakeId(), symbol: e.symbol, side: e.side, qty: e.qty, entryPrice: e.entryPrice, entryTime: t });
          trades.push({ t, strategy: "vwap_reversion", action: "entry", symbol: e.symbol, side: e.side, distancePct: e.distancePct, rsi: e.rsi });
        }
        if (vwapOpen.length > VWAP_MAX) warnings.push(`vwap: superato il tetto di ${VWAP_MAX} posizioni a ${t} (${vwapOpen.length})`);

        const orbFree = ORB_MAX - orbOpen.length;
        const orbInputs: Record<string, OrbEntryInputs> = {};
        for (const s of symbolsWithData) {
          const range = openingRanges[s];
          const atr = atrPct[s];
          const bars = barsSoFar[s];
          const price = prices[s];
          if (!range || atr == null || bars.length === 0 || price == null) continue;
          const avgVol = bars.reduce((sum, b) => sum + b.v, 0) / bars.length;
          orbInputs[s] = { price, openingRange: range, atrPct: atr, avgBarVolume: avgVol, latestBarVolume: bars[bars.length - 1].v };
        }
        const orbEntries = decideOrbEntries(symbolsWithData, new Set(orbOpen.map((p) => p.symbol)), orbInputs, orbFree);
        for (const e of orbEntries) {
          orbOpen.push({ id: fakeId(), symbol: e.symbol, side: e.side, qty: e.qty, entryPrice: e.entryPrice, stopPrice: e.stopPrice, targetPrice: e.targetPrice });
          trades.push({ t, strategy: "orb", action: "entry", symbol: e.symbol, side: e.side, entryPrice: e.entryPrice, stopPrice: e.stopPrice, targetPrice: e.targetPrice });
        }
        if (orbOpen.length > ORB_ATR && orbOpen.length > ORB_MAX) warnings.push(`orb: superato il tetto di ${ORB_MAX} posizioni a ${t} (${orbOpen.length})`);

        const pairsFree = MAX_PAIRS - new Set(pairsOpen.map((l) => l.pairKey)).size;
        const pairsEntries = decidePairsEntries(pairStats, new Set(pairsOpen.map((l) => l.pairKey)), prices, pairsFree);
        for (const e of pairsEntries) {
          for (const leg of e.legs) {
            pairsOpen.push({ id: fakeId(), pairKey: e.pairKey, symbol: leg.symbol, side: leg.side, qty: leg.qty, entryPrice: leg.entryPrice });
          }
          trades.push({ t, strategy: "pairs", action: "entry", pairKey: e.pairKey, z: e.z, legs: e.legs });
        }
      }
    }

    // Rete di sicurezza EOD sui prezzi dell'ultima barra della giornata.
    const lastPrices: Record<string, number> = {};
    for (const s of symbolsWithData) {
      const bars = dayBars[s];
      if (bars.length > 0) lastPrices[s] = bars[bars.length - 1].c;
    }
    const remaining: LabOpenRow[] = [
      ...vwapOpen.map((p) => ({ id: p.id, symbol: p.symbol, side: p.side, qty: p.qty, entryPrice: p.entryPrice })),
      ...orbOpen.map((p) => ({ id: p.id, symbol: p.symbol, side: p.side, qty: p.qty, entryPrice: p.entryPrice })),
      ...pairsOpen.map((l) => ({ id: l.id, symbol: l.symbol, side: l.side, qty: l.qty, entryPrice: l.entryPrice })),
    ];
    const eodCloses = decideLabEodCloses(remaining, lastPrices);
    for (const c of eodCloses) trades.push({ t: sessionEnd, action: "eod_close", id: c.id, realizedPnl: c.realizedPnl });

    const stillOpenAtEnd = remaining.length - eodCloses.length;
    if (stillOpenAtEnd > 0) warnings.push(`${stillOpenAtEnd} posizioni restano aperte a fine giornata dopo la rete di sicurezza EOD (unrealized negativo, atteso)`);

    const summary: Record<string, { entries: number; exits: number; realizedPnl: number }> = {
      vwap_reversion: { entries: 0, exits: 0, realizedPnl: 0 },
      orb: { entries: 0, exits: 0, realizedPnl: 0 },
      pairs: { entries: 0, exits: 0, realizedPnl: 0 },
    };
    for (const tr of trades) {
      const strategy = (tr.strategy as string) ?? (tr.action === "eod_close" ? null : null);
      if (strategy && summary[strategy]) {
        if (tr.action === "entry") summary[strategy].entries++;
        if (tr.action === "exit") {
          summary[strategy].exits++;
          summary[strategy].realizedPnl += Number(tr.realizedPnl ?? 0);
        }
      }
    }

    res.status(200).json({
      date,
      symbolsWithData: symbolsWithData.length,
      ticksSimulated: tickTimestamps.length,
      pairsSelected: pairStats.map((p) => ({ pair: pairKey(p.a, p.b), correlation: Math.round(p.correlation * 100) / 100 })),
      summary,
      warnings,
      tradeCount: trades.length,
      trades,
    });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message, warnings });
  }
}

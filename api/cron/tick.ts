import type { VercelRequest, VercelResponse } from "@vercel/node";
import { alpacaDataFetch, alpacaFetch } from "../../server/alpaca.js";
import { db } from "../../server/db.js";
import { UNIVERSE_SYMBOLS } from "../../server/universe.js";
import {
  MAX_POSITIONS,
  STRATEGY_ID,
  decideEntries,
  decideExits,
  type Bar,
  type OpenPosition,
  type Snapshot,
} from "../../server/vwapReversion.js";

interface AlpacaClock {
  is_open: boolean;
  next_close: string;
  next_open: string;
}

interface AlpacaSnapshotRaw {
  latestTrade?: { p: number };
  dailyBar?: { c: number; vw: number };
}

interface AlpacaBarRaw {
  t: string;
  c: number;
}

async function fetchSnapshots(): Promise<Record<string, Snapshot>> {
  const symbols = UNIVERSE_SYMBOLS.join(",");
  const raw = await alpacaDataFetch<Record<string, AlpacaSnapshotRaw>>(
    `/v2/stocks/snapshots?symbols=${encodeURIComponent(symbols)}&feed=iex`
  );
  const out: Record<string, Snapshot> = {};
  for (const symbol of UNIVERSE_SYMBOLS) {
    const s = raw[symbol];
    const price = s?.dailyBar?.c ?? s?.latestTrade?.p;
    const vwap = s?.dailyBar?.vw;
    if (price != null && vwap != null) out[symbol] = { price, vwap };
  }
  return out;
}

async function fetchBars(): Promise<Record<string, Bar[]>> {
  const symbols = UNIVERSE_SYMBOLS.join(",");
  const start = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const raw = await alpacaDataFetch<{ bars?: Record<string, AlpacaBarRaw[]> }>(
    `/v2/stocks/bars?symbols=${encodeURIComponent(symbols)}&timeframe=5Min&limit=3000&feed=iex&sort=desc&start=${encodeURIComponent(start)}`
  );
  const out: Record<string, Bar[]> = {};
  for (const symbol of UNIVERSE_SYMBOLS) {
    out[symbol] = (raw.bars?.[symbol] ?? []).map((b) => ({ t: b.t, c: b.c }));
  }
  return out;
}

interface OpenPositionRow {
  id: number;
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  entry_price: number;
  entry_time: string;
}

/**
 * Tick periodico invocato dallo scheduler GitHub Actions (.github/workflows/tick.yml)
 * ogni pochi minuti durante l'orario di mercato. Esegue la strategia VWAP reversion
 * (LAB C) per il laboratorio: chiude le posizioni che hanno raggiunto target/stop/tempo
 * massimo, poi apre nuove posizioni sugli slot liberi. Le altre due strategie (ORB,
 * pairs trading) non sono ancora implementate.
 */
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
    const [snapshots, barsBySymbol, openRows] = await Promise.all([
      fetchSnapshots(),
      fetchBars(),
      db()`SELECT id, symbol, side, qty::float8 AS qty, entry_price::float8 AS entry_price, entry_time
           FROM lab_positions WHERE strategy_id = ${STRATEGY_ID} AND status = 'open'` as unknown as Promise<OpenPositionRow[]>,
    ]);

    const openPositions: OpenPosition[] = openRows.map((r) => ({
      id: r.id,
      symbol: r.symbol,
      side: r.side,
      qty: r.qty,
      entryPrice: r.entry_price,
      entryTime: r.entry_time,
    }));

    const exits = decideExits(openPositions, snapshots, now);
    for (const exit of exits) {
      await db()`
        UPDATE lab_positions
        SET status = 'closed', exit_price = ${exit.exitPrice}, exit_time = ${now.toISOString()}, realized_pnl = ${exit.realizedPnl}
        WHERE id = ${exit.position.id}
      `;
    }

    const stillOpenSymbols = new Set(
      openPositions.filter((p) => !exits.some((e) => e.position.id === p.id)).map((p) => p.symbol)
    );
    const freeSlots = MAX_POSITIONS - stillOpenSymbols.size;
    const entries = decideEntries(UNIVERSE_SYMBOLS, stillOpenSymbols, snapshots, barsBySymbol, freeSlots);
    for (const entry of entries) {
      await db()`
        INSERT INTO lab_positions (strategy_id, symbol, side, qty, entry_price, entry_time, status)
        VALUES (${STRATEGY_ID}, ${entry.symbol}, ${entry.side}, ${entry.qty}, ${entry.entryPrice}, ${now.toISOString()}, 'open')
      `;
    }

    const note = `${exits.length} chiuse, ${entries.length} aperte, ${stillOpenSymbols.size + entries.length} posizioni aperte`;
    await db()`INSERT INTO tick_log (market_open, note) VALUES (true, ${note})`;

    res.status(200).json({
      marketOpen: true,
      closed: exits.map((e) => ({ symbol: e.position.symbol, reason: e.reason, realizedPnl: e.realizedPnl })),
      opened: entries.map((e) => ({ symbol: e.symbol, side: e.side, qty: e.qty, distancePct: e.distancePct, rsi: e.rsi })),
      openPositions: stillOpenSymbols.size + entries.length,
    });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}

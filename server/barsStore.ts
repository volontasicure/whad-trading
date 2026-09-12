// Persistenza delle barre di prezzo (giornaliere e a 5 minuti) in daily_bars/session_bars.
// Le strategie non leggono da qui: continuano a scaricare da Alpaca a ogni tick (vedi
// api/cron/tick.ts). Queste tabelle servono solo a conservare lo storico per analisi future
// (es. attribuzione di performance), che altrimenti verrebbe scartato dopo ogni tick.

import { db } from "./db.js";

export interface DailyBarRow {
  symbol: string;
  tradingDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SessionBarRow {
  symbol: string;
  barTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap: number;
}

/** Upsert in blocco: una singola query multi-riga invece di N round trip. */
export async function saveDailyBars(rows: DailyBarRow[]): Promise<void> {
  if (rows.length === 0) return;
  const values: string[] = [];
  const params: unknown[] = [];
  rows.forEach((r, i) => {
    const base = i * 7;
    values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7})`);
    params.push(r.symbol, r.tradingDate, r.open, r.high, r.low, r.close, r.volume);
  });
  await db().query(
    `INSERT INTO daily_bars (symbol, trading_date, open, high, low, close, volume)
     VALUES ${values.join(",")}
     ON CONFLICT (symbol, trading_date) DO UPDATE SET
       open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
       close = EXCLUDED.close, volume = EXCLUDED.volume`,
    params
  );
}

export async function saveSessionBars(rows: SessionBarRow[]): Promise<void> {
  if (rows.length === 0) return;
  const values: string[] = [];
  const params: unknown[] = [];
  rows.forEach((r, i) => {
    const base = i * 8;
    values.push(
      `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8})`
    );
    params.push(r.symbol, r.barTime, r.open, r.high, r.low, r.close, r.volume, r.vwap);
  });
  await db().query(
    `INSERT INTO session_bars (symbol, bar_time, open, high, low, close, volume, vwap)
     VALUES ${values.join(",")}
     ON CONFLICT (symbol, bar_time) DO UPDATE SET
       open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
       close = EXCLUDED.close, volume = EXCLUDED.volume, vwap = EXCLUDED.vwap`,
    params
  );
}

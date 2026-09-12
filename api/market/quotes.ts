import type { VercelRequest, VercelResponse } from "@vercel/node";
import { alpacaDataFetch } from "../lib/alpaca.js";
import { UNIVERSE_SYMBOLS } from "../lib/universe.js";

interface AlpacaSnapshot {
  latestTrade?: { p: number };
  dailyBar?: { c: number };
  prevDailyBar?: { c: number };
}

interface SnapshotsResponse {
  [symbol: string]: AlpacaSnapshot;
}

export interface QuoteRow {
  symbol: string;
  price: number | null;
  changePct: number | null;
}

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const symbols = UNIVERSE_SYMBOLS.join(",");
    // feed=iex: disponibile su ogni account (anche paper senza abbonamento SIP a pagamento).
    const data = await alpacaDataFetch<{ snapshots?: SnapshotsResponse }>(
      `/v2/stocks/snapshots?symbols=${encodeURIComponent(symbols)}&feed=iex`
    );
    const snapshots = data.snapshots ?? {};

    const quotes: QuoteRow[] = UNIVERSE_SYMBOLS.map((symbol) => {
      const s = snapshots[symbol];
      const last = s?.dailyBar?.c ?? s?.latestTrade?.p ?? null;
      const prevClose = s?.prevDailyBar?.c ?? null;
      const changePct = last != null && prevClose ? ((last - prevClose) / prevClose) * 100 : null;
      return { symbol, price: last, changePct };
    });

    res.status(200).json(quotes);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}

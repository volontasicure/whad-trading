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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const symbols = UNIVERSE_SYMBOLS.join(",");
    // feed=iex: disponibile su ogni account (anche paper senza abbonamento SIP a pagamento).
    const data = await alpacaDataFetch<{ snapshots?: SnapshotsResponse } & SnapshotsResponse>(
      `/v2/stocks/snapshots?symbols=${encodeURIComponent(symbols)}&feed=iex`
    );

    if (req.query.debug === "1") {
      res.status(200).json(data);
      return;
    }

    // La forma esatta della risposta multi-simbolo varia secondo la versione API:
    // a volte è avvolta in { snapshots: {...} }, a volte è la mappa simbolo->snapshot diretta.
    const snapshots: SnapshotsResponse = data.snapshots ?? data;

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

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { alpacaFetch } from "../../server/alpaca.js";

interface AlpacaFillActivity {
  activity_type: "FILL";
  symbol: string;
  side: "buy" | "sell";
  qty: string;
  price: string;
  transaction_time: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const since = typeof req.query.since === "string" ? req.query.since : undefined;
  const qs = new URLSearchParams({ direction: "asc", ...(since ? { after: since } : {}) });
  try {
    const raw = await alpacaFetch<AlpacaFillActivity[]>(`/v2/account/activities/FILL?${qs.toString()}`);
    const executions = raw.map((f) => ({
      ts: f.transaction_time,
      symbol: f.symbol,
      action: f.side === "buy" ? ("BUY" as const) : ("SELL" as const),
      qty: Number(f.qty),
      price: Number(f.price),
      // Alpaca non fornisce il realized per singolo fill via REST (serve lot-matching lato nostro): non ancora calcolato.
      realized: null,
    }));
    res.status(200).json(executions);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}

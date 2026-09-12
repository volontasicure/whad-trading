import type { VercelRequest, VercelResponse } from "@vercel/node";
import { alpacaFetch } from "../../server/alpaca.js";

interface AlpacaPosition {
  symbol: string;
  side: "long" | "short";
  qty: string;
  avg_entry_price: string;
  current_price: string;
  unrealized_pl: string;
}

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const raw = await alpacaFetch<AlpacaPosition[]>("/v2/positions");
    const positions = raw.map((p) => ({
      symbol: p.symbol,
      side: p.side === "short" ? ("SHORT" as const) : ("LONG" as const),
      qty: Math.abs(Number(p.qty)),
      avgPrice: Number(p.avg_entry_price),
      lastPrice: Number(p.current_price),
      unrealized: Number(p.unrealized_pl),
      // Alpaca non espone il realized-per-titolo via REST: va ricavato dalle activity FILL (vedi /api/broker/executions).
      realizedToday: 0,
    }));
    res.status(200).json(positions);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}

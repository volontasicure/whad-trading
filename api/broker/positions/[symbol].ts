import type { VercelRequest, VercelResponse } from "@vercel/node";
import { alpacaFetch } from "../../../server/alpaca.js";

interface AlpacaOrder {
  id: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "DELETE") {
    res.status(405).json({ error: "Metodo non consentito, usare DELETE" });
    return;
  }
  const symbol = typeof req.query.symbol === "string" ? req.query.symbol : undefined;
  if (!symbol) {
    res.status(400).json({ error: "Simbolo mancante" });
    return;
  }

  try {
    const order = await alpacaFetch<AlpacaOrder>(`/v2/positions/${encodeURIComponent(symbol)}`, { method: "DELETE" });
    res.status(200).json({ orderId: order.id });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}

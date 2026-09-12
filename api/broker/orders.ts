import type { VercelRequest, VercelResponse } from "@vercel/node";
import { alpacaFetch } from "../lib/alpaca.js";

interface OrderBody {
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  type: "market" | "limit";
  limitPrice?: number;
}

interface AlpacaOrder {
  id: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Metodo non consentito, usare POST" });
    return;
  }
  const body = req.body as OrderBody;
  if (!body?.symbol || !body?.side || !body?.qty || !body?.type) {
    res.status(400).json({ error: "Corpo richiesta non valido: servono symbol, side, qty, type" });
    return;
  }

  try {
    const order = await alpacaFetch<AlpacaOrder>("/v2/orders", {
      method: "POST",
      body: JSON.stringify({
        symbol: body.symbol,
        side: body.side,
        qty: body.qty,
        type: body.type,
        time_in_force: "day",
        ...(body.type === "limit" && body.limitPrice ? { limit_price: body.limitPrice } : {}),
      }),
    });
    res.status(200).json({ orderId: order.id });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}

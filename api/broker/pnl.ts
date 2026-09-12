import type { VercelRequest, VercelResponse } from "@vercel/node";
import { alpacaFetch } from "../lib/alpaca";

interface AlpacaPortfolioHistory {
  profit_loss: number[];
  timestamp: number[];
}

const PERIOD_PARAMS: Record<string, { period: string; timeframe: string }> = {
  day: { period: "1D", timeframe: "15Min" },
  week: { period: "1W", timeframe: "1D" },
  month: { period: "1M", timeframe: "1D" },
  inception: { period: "all", timeframe: "1D" },
};

/**
 * Approssimazione: la portfolio history di Alpaca riflette la variazione di equity
 * (realized + unrealized), non solo il realized "incassato" richiesto dalla spec.
 * Isolare il solo realized richiederebbe lot-matching sulle FILL — non ancora implementato.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const period = typeof req.query.period === "string" ? req.query.period : "day";
  const params = PERIOD_PARAMS[period];
  if (!params) {
    res.status(400).json({ error: `periodo non valido: ${period}` });
    return;
  }

  try {
    const qs = new URLSearchParams({ period: params.period, timeframe: params.timeframe });
    const history = await alpacaFetch<AlpacaPortfolioHistory>(`/v2/account/portfolio/history?${qs.toString()}`);
    const value = (history.profit_loss ?? []).reduce((sum, v) => sum + (v ?? 0), 0);
    res.status(200).json({ value, approximate: true });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}

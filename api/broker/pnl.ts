import type { VercelRequest, VercelResponse } from "@vercel/node";
import { computeRealPeriodPnl } from "../../server/periodPnl.js";

const VALID_PERIODS = new Set(["day", "week", "month", "inception"]);

/**
 * Realized P&L del conto reale calcolato da noi su real_positions (server/periodPnl.ts,
 * computeRealPeriodPnl), non più dalla portfolio history di Alpaca (che mescola realized e
 * unrealized). Nel nostro modello ogni riga è un round-trip completo (mai scale-in/out
 * parziali), quindi il realized per fill è già esatto — non serve lot-matching sui dati del
 * broker.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const period = typeof req.query.period === "string" ? req.query.period : "day";
  if (!VALID_PERIODS.has(period)) {
    res.status(400).json({ error: `periodo non valido: ${period}` });
    return;
  }

  try {
    const pnl = await computeRealPeriodPnl();
    const value =
      period === "day"
        ? pnl.lastSession
        : period === "week"
          ? pnl.previousWeek
          : period === "month"
            ? pnl.previousMonth
            : pnl.sinceInception;
    res.status(200).json({ value });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}

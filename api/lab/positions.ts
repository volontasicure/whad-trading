import type { VercelRequest, VercelResponse } from "@vercel/node";
import { db } from "../../server/db.js";
import { fetchMarketSession } from "../../server/marketHours.js";

interface Row {
  strategy_id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  entry_price: number;
  realized_pnl: number | null;
  status: string;
}

export interface RealLabPosition {
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  entryPrice: number;
}

export interface RealLabStrategyData {
  openPositions: RealLabPosition[];
  realizedToday: number;
}

/**
 * Confine della sessione da usare per "realizedToday": quella di oggi se il mercato ha già
 * aperto (anche se ora è chiuso), altrimenti l'ultima sessione chiusa disponibile — mai
 * mezzanotte UTC, che non ha alcun rapporto con l'orario NYSE e fa sparire silenziosamente
 * il risultato di ieri non appena scatta la mezzanotte UTC, ben prima della riapertura reale
 * (stesso tipo di bug della contaminazione pre-market già corretto in marketHours.ts).
 */
async function resolveRealizedSessionStartUtc(): Promise<string | null> {
  const todayIso = new Date().toISOString().slice(0, 10);
  const todaySession = await fetchMarketSession(todayIso);
  if (todaySession && new Date(todaySession.openUtc).getTime() <= Date.now()) {
    return todaySession.openUtc;
  }

  const lastRows = (await db()`
    SELECT max(exit_time) AS last_exit FROM lab_positions WHERE status = 'closed'
  `) as unknown as { last_exit: string | null }[];
  const lastExit = lastRows[0]?.last_exit;
  if (!lastExit) return null;

  const lastSession = await fetchMarketSession(lastExit.slice(0, 10));
  return lastSession?.openUtc ?? null;
}

/** Posizioni aperte (sempre correnti) + realized dell'ultima sessione rilevante per ogni strategia che ha dati reali. */
export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const sessionOpenUtc = await resolveRealizedSessionStartUtc();

    const rows = (await db()`
      SELECT strategy_id, symbol, side, qty::float8 AS qty, entry_price::float8 AS entry_price,
             realized_pnl::float8 AS realized_pnl, status
      FROM lab_positions
      WHERE status = 'open' OR (status = 'closed' AND exit_time >= ${sessionOpenUtc ?? "9999-01-01"})
    `) as unknown as Row[];

    const byStrategy: Record<string, RealLabStrategyData> = {};
    for (const r of rows) {
      if (!byStrategy[r.strategy_id]) byStrategy[r.strategy_id] = { openPositions: [], realizedToday: 0 };
      if (r.status === "open") {
        byStrategy[r.strategy_id].openPositions.push({
          symbol: r.symbol,
          side: r.side,
          qty: r.qty,
          entryPrice: r.entry_price,
        });
      } else {
        byStrategy[r.strategy_id].realizedToday += r.realized_pnl ?? 0;
      }
    }

    res.status(200).json(byStrategy);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { db } from "../../server/db.js";

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

/** Posizioni aperte + realized di oggi per ogni strategia che ha dati reali in lab_positions. */
export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const rows = (await db()`
      SELECT strategy_id, symbol, side, qty::float8 AS qty, entry_price::float8 AS entry_price,
             realized_pnl::float8 AS realized_pnl, status
      FROM lab_positions
      WHERE status = 'open' OR (status = 'closed' AND exit_time >= ${todayStart.toISOString()})
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

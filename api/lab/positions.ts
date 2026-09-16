import type { VercelRequest, VercelResponse } from "@vercel/node";
import { db } from "../../server/db.js";
import { fetchMarketSession } from "../../server/marketHours.js";
import { computeLabPeriodPnl, computeRealPeriodPnl } from "../../server/periodPnl.js";

/** Chiave usata per il portafoglio REALE in questa risposta, accanto alle 3 strategie lab. */
const REAL_PORTFOLIO_KEY = "real";

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
  previousWeek: number;
  previousMonth: number;
  sinceInception: number;
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
  `) as unknown as { last_exit: Date | null }[];
  const lastExit = lastRows[0]?.last_exit;
  if (!lastExit) return null;

  const lastSession = await fetchMarketSession(new Date(lastExit).toISOString().slice(0, 10));
  return lastSession?.openUtc ?? null;
}

function emptyStrategyData(): RealLabStrategyData {
  return { openPositions: [], realizedToday: 0, previousWeek: 0, previousMonth: 0, sinceInception: 0 };
}

/**
 * Posizioni aperte (sempre correnti) + realized dell'ultima sessione rilevante per ogni
 * strategia lab che ha dati reali, più gli aggregati per periodo (settimana/mese/da inizio,
 * finestre mobili sulle sedute chiuse — vedi server/periodPnl.ts) per le 3 strategie lab e
 * per il portafoglio REALE (chiave "real", proxy da sessions.net).
 */
export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const sessionOpenUtc = await resolveRealizedSessionStartUtc();

    const [rows, labPeriods, realPeriod] = await Promise.all([
      db()`
        SELECT strategy_id, symbol, side, qty::float8 AS qty, entry_price::float8 AS entry_price,
               realized_pnl::float8 AS realized_pnl, status
        FROM lab_positions
        WHERE status = 'open' OR (status = 'closed' AND exit_time >= ${sessionOpenUtc ?? "9999-01-01"})
      ` as unknown as Promise<Row[]>,
      computeLabPeriodPnl(),
      computeRealPeriodPnl(),
    ]);

    const byStrategy: Record<string, RealLabStrategyData> = {};
    for (const r of rows) {
      if (!byStrategy[r.strategy_id]) byStrategy[r.strategy_id] = emptyStrategyData();
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

    for (const [strategyId, period] of Object.entries(labPeriods)) {
      if (!byStrategy[strategyId]) byStrategy[strategyId] = emptyStrategyData();
      byStrategy[strategyId].previousWeek = period.previousWeek;
      byStrategy[strategyId].previousMonth = period.previousMonth;
      byStrategy[strategyId].sinceInception = period.sinceInception;
    }

    byStrategy[REAL_PORTFOLIO_KEY] = {
      ...emptyStrategyData(),
      realizedToday: realPeriod.lastSession,
      previousWeek: realPeriod.previousWeek,
      previousMonth: realPeriod.previousMonth,
      sinceInception: realPeriod.sinceInception,
    };

    res.status(200).json(byStrategy);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { db } from "../server/db.js";
import { computeRanking } from "../server/debrief.js";
import { computeEligibility, computeWeights } from "../server/strategyAllocation.js";

interface SessionRow {
  trading_date: string;
  strategy_id: string;
  net: number;
  deviation_pct: number;
  trades: number;
  costs: number;
  confirmed_at: string | null;
}

const HISTORY_LIMIT = 20;

/**
 * GET: classifica del debriefing (netto reale ultime 20 sedute, solo informativa), allocazione
 * del capitale reale di oggi (server/strategyAllocation.ts: quali strategie sono ammesse e con
 * che peso — dal 25/9/2026 non è più un'unica proposta esclusiva), stato di conferma di oggi, e
 * storico sedute reale — tutto da lab_positions/sessions, niente dati finti.
 *
 * POST: registra la conferma di oggi (bottone "Conferma e attiva"). Segna solo che l'utente ha
 * confermato l'allocazione; la riga sessions per oggi verrà scritta stasera da eod-close.ts,
 * che a quel punto legge questa conferma.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "POST") {
    try {
      const tradingDate = new Date().toISOString().slice(0, 10);
      await db()`
        INSERT INTO debrief_confirmations (trading_date, confirmed_at) VALUES (${tradingDate}, now())
        ON CONFLICT (trading_date) DO UPDATE SET confirmed_at = EXCLUDED.confirmed_at
      `;
      const rows = (await db()`
        SELECT confirmed_at FROM debrief_confirmations WHERE trading_date = ${tradingDate}
      `) as unknown as { confirmed_at: string }[];
      res.status(200).json({ confirmedAt: rows[0]?.confirmed_at ?? null });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ error: "Metodo non consentito, usare GET o POST" });
    return;
  }

  try {
    const tradingDate = new Date().toISOString().slice(0, 10);
    // ranking/sessionsUsed restano solo per la tabella di classifica mostrata in UI — non
    // decidono più l'allocazione, vedi server/strategyAllocation.ts sotto.
    const { entries, sessionsUsed } = await computeRanking(tradingDate);
    const eligibility = await computeEligibility(tradingDate);
    const weights = computeWeights(eligibility);
    const allocation = eligibility.map((e) => ({ ...e, weight: weights[e.strategyId] ?? 0 }));

    const confirmRows = (await db()`
      SELECT confirmed_at FROM debrief_confirmations WHERE trading_date = ${tradingDate}
    `) as unknown as { confirmed_at: string }[];

    const sessionRows = (await db()`
      SELECT trading_date, strategy_id, net::float8 AS net, deviation_pct::float8 AS deviation_pct,
             trades, costs::float8 AS costs, confirmed_at
      FROM sessions ORDER BY trading_date DESC LIMIT ${HISTORY_LIMIT}
    `) as unknown as SessionRow[];

    res.status(200).json({
      ranking: entries,
      sessionsUsed,
      allocation,
      confirmedAt: confirmRows[0]?.confirmed_at ?? null,
      sessions: sessionRows.map((r) => ({
        tradingDate: r.trading_date,
        strategyId: r.strategy_id,
        net: r.net,
        deviationPct: r.deviation_pct,
        trades: r.trades,
        costs: r.costs,
        confirmedAt: r.confirmed_at,
      })),
    });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}

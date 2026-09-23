import type { VercelRequest, VercelResponse } from "@vercel/node";
import { db } from "../server/db.js";
import { computeRanking, PROPOSED_STRATEGY_ID } from "../server/debrief.js";

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
 * GET: classifica del debriefing (netto reale ultime 20 sedute), proposta del giorno, stato
 * di conferma di oggi, e storico sedute reale — tutto da lab_positions/sessions, niente dati
 * finti. proposedStrategyId è null finché non esiste ancora nessuna seduta chiusa (giorno 1).
 *
 * POST: registra la conferma di oggi (bottone "Conferma e attiva"). Non esegue nessun ordine
 * reale — vedi CLAUDE.md "Prossimi passi" #2, ancora da progettare — segna solo che l'utente
 * ha confermato la proposta; la riga sessions per oggi verrà scritta stasera da eod-close.ts,
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
    const { entries, sessionsUsed } = await computeRanking(tradingDate);
    // Dal 23/9/2026 la proposta non è più il primo della classifica — vedi PROPOSED_STRATEGY_ID
    // in server/debrief.ts. entries/sessionsUsed restano solo per la tabella di classifica.
    const proposedStrategyId = sessionsUsed > 0 ? PROPOSED_STRATEGY_ID : null;

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
      proposedStrategyId,
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

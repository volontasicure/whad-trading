import type { VercelRequest, VercelResponse } from "@vercel/node";
import { alpacaFetch } from "../../server/alpaca.js";
import { db } from "../../server/db.js";
import { fetchMarketSession } from "../../server/marketHours.js";
import { CAPITAL } from "../../server/pairsTrading.js";
import { computeRanking, todayResultFor, STRATEGY_IDS } from "../../server/debrief.js";

interface AlpacaClock {
  is_open: boolean;
  next_close: string;
}

interface AlpacaPosition {
  symbol: string;
  unrealized_pl: string;
}

const CLOSE_WINDOW_MINUTES = 20;

/**
 * Scrive la riga sessions di oggi (storico reale del debriefing) — una volta sola, qui,
 * perché questo cron gira una volta al giorno vicino alla chiusura ed è il momento in cui
 * "il risultato reale di oggi" è finalmente conosciuto. strategy_id è la proposta del
 * debriefing di stamattina: lo stesso calcolo (server/debrief.ts) usato da GET /api/debrief,
 * ricalcolato qui invece di fidarsi di uno stato salvato — usa solo sedute *precedenti* a
 * oggi, quindi il risultato è identico a qualunque ora venga chiesto. Se non c'è ancora
 * nessuno storico (giorno 1), non scrive nulla: non esiste una proposta sensata da segnare.
 * Best-effort: un problema qui non deve mai far fallire la chiusura reale sopra, che è la
 * responsabilità primaria di questo endpoint.
 */
async function finalizeTodaySession(): Promise<{ skipped: true; reason: string } | { skipped: false; strategyId: string; net: number }> {
  const tradingDate = new Date().toISOString().slice(0, 10);
  const { entries, sessionsUsed } = await computeRanking(tradingDate);
  if (sessionsUsed === 0) return { skipped: true, reason: "nessuno storico di sedute precedenti ancora" };

  const proposedStrategyId = entries[0].strategyId;
  const session = await fetchMarketSession(tradingDate);
  if (!session) return { skipped: true, reason: "nessuna sessione di mercato per oggi nel calendario" };

  const todayByStrategy = new Map<string, { net: number; trades: number }>();
  for (const id of STRATEGY_IDS) {
    todayByStrategy.set(id, await todayResultFor(id, session.openUtc));
  }
  const proposedToday = todayByStrategy.get(proposedStrategyId)?.net ?? 0;
  const proposedTrades = todayByStrategy.get(proposedStrategyId)?.trades ?? 0;
  const others = STRATEGY_IDS.filter((id) => id !== proposedStrategyId).map((id) => todayByStrategy.get(id)?.net ?? 0);
  const avgOthers = others.reduce((s, n) => s + n, 0) / others.length;
  // % di quanto il lab scelto si è discostato dalla media degli altri due, sul capitale — non
  // "lab vs conto reale" (non ancora eseguito per davvero, vedi CLAUDE.md Prossimi passi #2).
  const deviationPct = ((proposedToday - avgOthers) / CAPITAL) * 100;

  const confirmRows = (await db()`
    SELECT confirmed_at FROM debrief_confirmations WHERE trading_date = ${tradingDate}
  `) as unknown as { confirmed_at: string }[];

  await db()`
    INSERT INTO sessions (trading_date, strategy_id, net, deviation_pct, trades, costs, confirmed_at)
    VALUES (${tradingDate}, ${proposedStrategyId}, ${proposedToday}, ${deviationPct}, ${proposedTrades}, 0, ${confirmRows[0]?.confirmed_at ?? null})
    ON CONFLICT (trading_date) DO UPDATE SET
      strategy_id = EXCLUDED.strategy_id, net = EXCLUDED.net, deviation_pct = EXCLUDED.deviation_pct,
      trades = EXCLUDED.trades, costs = EXCLUDED.costs, confirmed_at = EXCLUDED.confirmed_at
  `;

  return { skipped: false, strategyId: proposedStrategyId, net: proposedToday };
}

/**
 * Chiude ogni posizione reale con unrealized positivo, a ridosso della chiusura di mercato,
 * e finalizza la riga sessions del debriefing reale (finalizeTodaySession) — stesso cron
 * perché entrambe le cose hanno senso solo "a ridosso della chiusura", per non aggiungere
 * una funzione serverless in più (limite di 12 sul piano Hobby, già al tetto). Invocata da
 * Vercel Cron (vercel.json) una volta al giorno nei feriali.
 *
 * Limite noto: Vercel Cron su piano Hobby ammette un solo orario UTC fisso al giorno, ma la
 * chiusura NYSE (16:00 ET) cade a un'ora UTC diversa secondo l'ora legale USA (20:00 UTC in
 * EDT, 21:00 UTC in EST). Lo schedule qui sotto è tarato su EDT (la maggior parte dell'anno,
 * marzo-novembre): nei mesi EST il mercato risulterà già chiuso quando il cron parte e sia la
 * chiusura reale sia la scrittura di sessions verranno saltate quel giorno. Per coprire
 * entrambi i periodi servirebbe un cron più frequente (piano Pro) o uno scheduler
 * timezone-aware esterno — non ancora fatto.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = req.headers.authorization;
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: "Non autorizzato" });
    return;
  }

  try {
    const clock = await alpacaFetch<AlpacaClock>("/v2/clock");

    if (!clock.is_open) {
      res.status(200).json({ skipped: true, reason: "mercato chiuso", nextClose: clock.next_close });
      return;
    }

    const minutesToClose = (new Date(clock.next_close).getTime() - Date.now()) / 60_000;
    if (minutesToClose > CLOSE_WINDOW_MINUTES) {
      res.status(200).json({
        skipped: true,
        reason: `fuori dalla finestra di chiusura (mancano ${Math.round(minutesToClose)} min)`,
        nextClose: clock.next_close,
      });
      return;
    }

    const positions = await alpacaFetch<AlpacaPosition[]>("/v2/positions");
    const toClose = positions.filter((p) => Number(p.unrealized_pl) > 0);

    const results = await Promise.allSettled(
      toClose.map((p) => alpacaFetch(`/v2/positions/${encodeURIComponent(p.symbol)}`, { method: "DELETE" }))
    );
    const closed = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.length - closed;

    // Best-effort: un problema qui non deve far apparire fallita la chiusura reale sopra,
    // che è già andata a buon fine a questo punto.
    let session: Awaited<ReturnType<typeof finalizeTodaySession>> | { skipped: true; reason: string };
    try {
      session = await finalizeTodaySession();
    } catch (err) {
      session = { skipped: true, reason: `errore: ${(err as Error).message}` };
    }

    res.status(200).json({
      skipped: false,
      evaluated: positions.length,
      closed,
      failed,
      symbols: toClose.map((p) => p.symbol),
      session,
    });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}

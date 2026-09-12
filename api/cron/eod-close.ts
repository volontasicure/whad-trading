import type { VercelRequest, VercelResponse } from "@vercel/node";
import { alpacaFetch } from "../lib/alpaca.js";

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
 * Chiude ogni posizione reale con unrealized positivo, a ridosso della chiusura di mercato.
 * Invocata da Vercel Cron (vercel.json) una volta al giorno nei feriali.
 *
 * Limite noto: Vercel Cron su piano Hobby ammette un solo orario UTC fisso al giorno, ma la
 * chiusura NYSE (16:00 ET) cade a un'ora UTC diversa secondo l'ora legale USA (20:00 UTC in
 * EDT, 21:00 UTC in EST). Lo schedule qui sotto è tarato su EDT (la maggior parte dell'anno,
 * marzo-novembre): nei mesi EST il mercato risulterà già chiuso quando il cron parte e la
 * chiusura verrà saltata. Per coprire entrambi i periodi servirebbe un cron più frequente
 * (piano Pro) o uno scheduler timezone-aware esterno — non ancora fatto.
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

    res.status(200).json({
      skipped: false,
      evaluated: positions.length,
      closed,
      failed,
      symbols: toClose.map((p) => p.symbol),
    });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}

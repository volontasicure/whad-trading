import type { VercelRequest, VercelResponse } from "@vercel/node";
import { alpacaFetch } from "../../server/alpaca.js";
import { runRealEodClose, finalizeTodaySession } from "../../server/realEod.js";

interface AlpacaClock {
  is_open: boolean;
  next_close: string;
}

const CLOSE_WINDOW_MINUTES = 20;

/**
 * Chiude le posizioni reali a ridosso della chiusura di mercato e finalizza la riga sessions
 * del debriefing reale — logica condivisa in server/realEod.ts (runRealEodClose,
 * finalizeTodaySession). Invocata da Vercel Cron (vercel.json) una volta al giorno nei feriali
 * e da GitHub Actions (eod-close.yml, finestra ripetuta).
 *
 * Dal 29/9/2026 questo endpoint è un BACKUP ridondante, non più il percorso primario: il
 * cron GitHub Actions dedicato (eod-close.yml) ha iniziato ad arrivare sistematicamente in
 * ritardo dal 24/9 (verificato con `gh run view --log`: fino a 3-5 ore dopo la chiusura reale,
 * quando il codice trova il mercato già chiuso e non chiude nulla) — probabilmente GitHub
 * deprioritizza sotto carico i workflow con molti trigger ravvicinati (3 cron × 5 min in
 * questo file). Il percorso primario ora è dentro api/cron/tick.ts (stesso scheduler
 * affidabile, tick.yml, un solo cron ogni 5 minuti tutto il giorno) — vedi server/realEod.ts
 * per la cronologia completa. Questo endpoint resta attivo per ridondanza, ma non ci si conta
 * più sopra da solo.
 *
 * Limite noto: Vercel Cron su piano Hobby ammette un solo orario UTC fisso al giorno, ma la
 * chiusura NYSE (16:00 ET) cade a un'ora UTC diversa secondo l'ora legale USA (20:00 UTC in
 * EDT, 21:00 UTC in EST). Lo schedule qui sotto è tarato su EDT (la maggior parte dell'anno,
 * marzo-novembre): nei mesi EST il mercato risulterà già chiuso quando il cron parte. Non è
 * più un problema pratico ora che tick.ts è il percorso primario.
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

    const closeResult = await runRealEodClose();

    // Best-effort: un problema qui non deve far apparire fallita la chiusura reale sopra,
    // che è già andata a buon fine a questo punto.
    let session: Awaited<ReturnType<typeof finalizeTodaySession>> | { skipped: true; reason: string };
    try {
      session = await finalizeTodaySession();
    } catch (err) {
      session = { skipped: true, reason: `errore: ${(err as Error).message}` };
    }

    res.status(200).json({ skipped: false, ...closeResult, session });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}

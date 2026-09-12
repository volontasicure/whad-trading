import type { VercelRequest, VercelResponse } from "@vercel/node";
import { alpacaDataFetch, alpacaFetch } from "../../server/alpaca.js";
import { db } from "../../server/db.js";

interface AlpacaClock {
  is_open: boolean;
  next_close: string;
  next_open: string;
}

/**
 * Tick periodico invocato dallo scheduler GitHub Actions (.github/workflows/tick.yml)
 * ogni pochi minuti durante l'orario di mercato. Per ora è uno scheletro: verifica se
 * il mercato è aperto e lo registra in `tick_log`, senza ancora eseguire nessuna logica
 * di strategia — serve a validare che l'intera pipeline (scheduler → auth → DB) funzioni
 * prima di aggiungere le regole reali di ORB/pairs/VWAP reversion.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = req.headers.authorization;
  if (!process.env.TICK_SECRET || auth !== `Bearer ${process.env.TICK_SECRET}`) {
    res.status(401).json({ error: "Non autorizzato" });
    return;
  }

  if (req.query.debugBars === "1") {
    try {
      const data = await alpacaDataFetch(
        "/v2/stocks/bars?symbols=AAPL,MSFT&timeframe=5Min&limit=5&feed=iex&sort=desc"
      );
      res.status(200).json(data);
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
    return;
  }

  try {
    const clock = await alpacaFetch<AlpacaClock>("/v2/clock");
    const note = clock.is_open
      ? "mercato aperto — nessuna logica di strategia ancora implementata"
      : `mercato chiuso, prossima apertura ${clock.next_open}`;

    await db()`
      INSERT INTO tick_log (market_open, note)
      VALUES (${clock.is_open}, ${note})
    `;

    res.status(200).json({ marketOpen: clock.is_open, note, nextClose: clock.next_close, nextOpen: clock.next_open });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}

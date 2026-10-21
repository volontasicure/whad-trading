import type { VercelRequest, VercelResponse } from "@vercel/node";
import { buildTrendSnapshot } from "../../server/trendRunner.js";

/**
 * Stato del LAB D (trend ETF) per la UI: equity, posizioni, segnali all'ultimo ribilanciamento. Sola lettura,
 * nessuna autenticazione (stessa scelta degli altri endpoint di lettura: app single-user, solo conto di prova).
 */
export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    res.status(200).json(await buildTrendSnapshot(new Date().toISOString().slice(0, 10)));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}

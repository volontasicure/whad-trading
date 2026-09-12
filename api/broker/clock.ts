import type { VercelRequest, VercelResponse } from "@vercel/node";
import { alpacaFetch } from "../lib/alpaca.js";

interface AlpacaClock {
  is_open: boolean;
  next_open: string;
  next_close: string;
}

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const clock = await alpacaFetch<AlpacaClock>("/v2/clock");
    res.status(200).json({ isOpen: clock.is_open, nextOpen: clock.next_open, nextClose: clock.next_close });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}

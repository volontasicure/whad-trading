import type { VercelRequest, VercelResponse } from "@vercel/node";
import { AlpacaNotConfiguredError, alpacaFetch, currentCredentialsSafe } from "../../server/alpaca.js";

interface AlpacaAccount {
  status: string;
}

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const safe = currentCredentialsSafe();
  if (!safe) {
    res.status(200).json({
      id: "alpaca",
      displayName: "Alpaca",
      connected: false,
      environment: null,
      maskedKey: "nessuna chiave configurata",
    });
    return;
  }

  try {
    const account = await alpacaFetch<AlpacaAccount>("/v2/account");
    res.status(200).json({
      id: "alpaca",
      displayName: "Alpaca",
      connected: account.status === "ACTIVE",
      environment: safe.environment,
      maskedKey: `${safe.maskedKey} · conto ${safe.environment}`,
    });
  } catch (err) {
    if (err instanceof AlpacaNotConfiguredError) {
      res.status(200).json({ id: "alpaca", displayName: "Alpaca", connected: false, environment: null, maskedKey: "nessuna chiave configurata" });
      return;
    }
    res.status(502).json({ error: (err as Error).message });
  }
}

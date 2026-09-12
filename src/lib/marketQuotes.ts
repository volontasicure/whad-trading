export interface LiveQuote {
  price: number;
  changePct: number;
}

/** Legge le quotazioni reali dal backend; lancia se non disponibili (chiavi mancanti, rete, ecc.). */
export async function fetchLiveQuotes(): Promise<Record<string, LiveQuote>> {
  const res = await fetch("/api/market/quotes");
  if (!res.ok) {
    throw new Error(`quotes -> ${res.status}`);
  }
  const rows = (await res.json()) as { symbol: string; price: number | null; changePct: number | null }[];
  const out: Record<string, LiveQuote> = {};
  for (const row of rows) {
    if (row.price != null && row.changePct != null) {
      out[row.symbol] = { price: row.price, changePct: row.changePct };
    }
  }
  return out;
}

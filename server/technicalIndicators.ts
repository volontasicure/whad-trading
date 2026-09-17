// Indicatori tecnici generici, riusati da più strategie (server/{breakdownLadderShort,
// vwapReversion}.ts) — nessuna logica specifica di strategia qui, solo calcolo puro da
// chiusure giornaliere.

/** Media mobile semplice sulle ultime `period` chiusure (in ordine cronologico). */
export function computeSMA(closesAscending: number[], period: number): number | null {
  if (closesAscending.length < period) return null;
  const window = closesAscending.slice(-period);
  return window.reduce((a, b) => a + b, 0) / period;
}

/**
 * Efficiency Ratio di Kaufman: |movimento netto| / somma dei |movimenti giornalieri| su
 * `period` giorni. 1 = movimento perfettamente direzionale, 0 = puro rumore senza progresso
 * netto (whipsaw). Richiede period+1 chiusure (per avere `period` variazioni giornaliere).
 */
export function computeTrendEfficiency(closesAscending: number[], period: number): number | null {
  if (closesAscending.length < period + 1) return null;
  const window = closesAscending.slice(-(period + 1));
  const netMove = Math.abs(window[window.length - 1] - window[0]);
  let sumAbsMoves = 0;
  for (let i = 1; i < window.length; i++) sumAbsMoves += Math.abs(window[i] - window[i - 1]);
  return sumAbsMoves > 0 ? netMove / sumAbsMoves : 0;
}

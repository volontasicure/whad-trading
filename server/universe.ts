/**
 * I 40 simboli dell'universo investibile (allargato da 20 dopo il primo giorno live,
 * per dare più coppie per settore al pairs trading — vedi CLAUDE.md "Prossimi passi").
 * Deve restare in sync con i simboli (non i prezzi, quelli sono solo fallback) in
 * src/data/mockData.ts — duplicato qui perché le funzioni serverless non condividono
 * il bundle con il frontend Vite. Raggruppamento settoriale in server/pairsTrading.ts#SECTORS.
 */
export const UNIVERSE_SYMBOLS: string[] = [
  // tech
  "AAPL",
  "MSFT",
  "NVDA",
  "GOOGL",
  "META",
  "TXN",
  "AVGO",
  "ORCL",
  "CRM",
  // financials
  "JPM",
  "BAC",
  "V",
  "MA",
  "WFC",
  "GS",
  // energy
  "XOM",
  "CVX",
  "COP",
  "SLB",
  // staples
  "KO",
  "PEP",
  "PG",
  "WMT",
  "COST",
  // healthcare
  "UNH",
  "JNJ",
  "ABBV",
  "LLY",
  "MRK",
  "TMO",
  // industrials
  "CAT",
  "HON",
  "LIN",
  "BA",
  "GE",
  // consumer discretionary
  "AMZN",
  "HD",
  "MCD",
  "NKE",
  "SBUX",
];

// Logica reale della strategia "Pairs trading" (LAB B).
// Coppie cointegrate dello stesso settore: compra il titolo debole e vende quello forte
// quando lo spread supera 2σ, chiude sul rientro alla media. Parametri da src/data/mockData.ts.
//
// Semplificazione dichiarata: un vero test di cointegrazione (Engle-Granger / ADF) è
// complesso da implementare e verificare correttamente. Qui la selezione delle coppie usa
// la correlazione dei rendimenti giornalieri tra titoli dello stesso settore come proxy —
// non è cointegrazione statistica vera, ma è trasparente, deterministica e ricalcolata
// ogni giorno come richiesto dalla spec.

export const STRATEGY_ID = "pairs";
export const MAX_PAIRS = 10;
export const CAPITAL = 100_000;
export const ENTRY_Z = 2.0;
export const EXIT_Z = 0.3;
export const STOP_Z = 3.5;

export type Side = "LONG" | "SHORT";

/** Raggruppamento settoriale dei 20 titoli dell'universo — usato solo per candidare le coppie. */
export const SECTORS: Record<string, string> = {
  AAPL: "tech",
  MSFT: "tech",
  NVDA: "tech",
  GOOGL: "tech",
  META: "tech",
  TXN: "tech",
  JPM: "financials",
  BAC: "financials",
  V: "financials",
  XOM: "energy",
  CVX: "energy",
  KO: "staples",
  PEP: "staples",
  PG: "staples",
  UNH: "healthcare",
  JNJ: "healthcare",
  CAT: "industrials",
  HON: "industrials",
  LIN: "industrials",
  AMZN: "consumer_disc",
};

export interface PairStats {
  a: string;
  b: string;
  correlation: number;
  meanRatio: number;
  stdRatio: number;
}

function dailyLogReturns(closes: number[]): number[] {
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  return rets;
}

function correlation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;
  const xs = x.slice(-n);
  const ys = y.slice(-n);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? 0 : num / denom;
}

export function pairKey(a: string, b: string): string {
  return `${a}/${b}`;
}

function ratioStats(closesA: number[], closesB: number[]): { meanRatio: number; stdRatio: number } {
  const n = Math.min(closesA.length, closesB.length);
  const ratios: number[] = [];
  for (let i = 0; i < n; i++) {
    ratios.push(closesA[closesA.length - n + i] / closesB[closesB.length - n + i]);
  }
  const meanRatio = ratios.reduce((s, v) => s + v, 0) / ratios.length;
  const variance = ratios.reduce((s, v) => s + (v - meanRatio) ** 2, 0) / ratios.length;
  return { meanRatio, stdRatio: Math.sqrt(variance) };
}

/**
 * Statistiche per una coppia specifica, a prescindere dal fatto che sia tra le MAX_PAIRS
 * più correlate di oggi. Serve per non perdere di vista una posizione aperta la cui coppia
 * è uscita dalla selezione giornaliera — l'uscita va comunque valutata, non ignorata.
 */
export function statsForPair(a: string, b: string, closesBySymbolAscending: Record<string, number[]>): PairStats | null {
  const closesA = closesBySymbolAscending[a];
  const closesB = closesBySymbolAscending[b];
  if (!closesA || !closesB || closesA.length === 0 || closesB.length === 0) return null;
  const corr = correlation(dailyLogReturns(closesA), dailyLogReturns(closesB));
  return { a, b, correlation: corr, ...ratioStats(closesA, closesB) };
}

/**
 * Seleziona fino a MAX_PAIRS coppie candidate (stesso settore, massima correlazione sui
 * rendimenti giornalieri) e ne calcola media/deviazione standard del rapporto di prezzo,
 * base per lo z-score intraday. Richiede almeno ~20 chiusure giornaliere per titolo.
 */
export function selectPairs(closesBySymbolAscending: Record<string, number[]>): PairStats[] {
  const bySector = new Map<string, string[]>();
  for (const [symbol, sector] of Object.entries(SECTORS)) {
    const closes = closesBySymbolAscending[symbol];
    if (!closes || closes.length < 20) continue;
    if (!bySector.has(sector)) bySector.set(sector, []);
    bySector.get(sector)!.push(symbol);
  }

  const candidates: { a: string; b: string; correlation: number }[] = [];
  for (const symbols of bySector.values()) {
    for (let i = 0; i < symbols.length; i++) {
      for (let j = i + 1; j < symbols.length; j++) {
        const a = symbols[i];
        const b = symbols[j];
        const corr = correlation(
          dailyLogReturns(closesBySymbolAscending[a]),
          dailyLogReturns(closesBySymbolAscending[b])
        );
        candidates.push({ a, b, correlation: corr });
      }
    }
  }

  candidates.sort((x, y) => y.correlation - x.correlation);

  return candidates.slice(0, MAX_PAIRS).map(({ a, b, correlation: corr }) => ({
    a,
    b,
    correlation: corr,
    ...ratioStats(closesBySymbolAscending[a], closesBySymbolAscending[b]),
  }));
}

/** z-score del rapporto di prezzo corrente rispetto alla media/deviazione storica della coppia. */
export function currentZ(priceA: number, priceB: number, stats: PairStats): number | null {
  if (stats.stdRatio <= 0 || priceB === 0) return null;
  const ratio = priceA / priceB;
  return (ratio - stats.meanRatio) / stats.stdRatio;
}

export interface OpenLeg {
  id: number;
  pairKey: string;
  symbol: string;
  side: Side;
  qty: number;
  entryPrice: number;
}

export interface ExitDecision {
  pairKey: string;
  legIds: number[];
  realizedPnl: number;
  reason: "exit_target" | "stop";
}

export interface EntryLeg {
  symbol: string;
  side: Side;
  qty: number;
  entryPrice: number;
}

export interface EntryDecision {
  pairKey: string;
  legs: [EntryLeg, EntryLeg];
  z: number;
}

/** Chiude entrambe le gambe di una coppia sul rientro alla media o allo stop sullo spread. */
export function decideExits(
  openLegs: OpenLeg[],
  prices: Record<string, number>,
  statsByPairKey: Record<string, PairStats>
): ExitDecision[] {
  const byPair = new Map<string, OpenLeg[]>();
  for (const leg of openLegs) {
    if (!byPair.has(leg.pairKey)) byPair.set(leg.pairKey, []);
    byPair.get(leg.pairKey)!.push(leg);
  }

  const decisions: ExitDecision[] = [];
  for (const [key, legs] of byPair) {
    if (legs.length < 2) continue; // gamba orfana: non si tocca alla cieca
    const stats = statsByPairKey[key];
    if (!stats) continue;
    const priceA = prices[stats.a];
    const priceB = prices[stats.b];
    if (priceA == null || priceB == null) continue;

    const z = currentZ(priceA, priceB, stats);
    if (z == null) continue;

    const targetReached = Math.abs(z) <= EXIT_Z;
    const stopHit = Math.abs(z) >= STOP_Z;
    if (!targetReached && !stopHit) continue;

    let realizedPnl = 0;
    for (const leg of legs) {
      const price = prices[leg.symbol];
      if (price == null) continue;
      const dir = leg.side === "LONG" ? 1 : -1;
      realizedPnl += Math.round(leg.qty * (price - leg.entryPrice) * dir);
    }
    decisions.push({ pairKey: key, legIds: legs.map((l) => l.id), realizedPnl, reason: targetReached ? "exit_target" : "stop" });
  }
  return decisions;
}

/**
 * Apre nuove coppie sugli slot liberi: entra quando |z| >= ENTRY_Z, vendendo il titolo
 * relativamente forte e comprando quello debole (esposizione netta ≈ 0, capitale diviso
 * a metà tra le due gambe).
 */
export function decideEntries(
  pairs: PairStats[],
  openPairKeys: Set<string>,
  prices: Record<string, number>,
  freeSlots: number
): EntryDecision[] {
  if (freeSlots <= 0) return [];

  const candidates: (EntryDecision & { absZ: number })[] = [];
  for (const stats of pairs) {
    const key = pairKey(stats.a, stats.b);
    if (openPairKeys.has(key)) continue;
    const priceA = prices[stats.a];
    const priceB = prices[stats.b];
    if (priceA == null || priceB == null) continue;

    const z = currentZ(priceA, priceB, stats);
    if (z == null || Math.abs(z) < ENTRY_Z) continue;

    const capitalPerLeg = CAPITAL / MAX_PAIRS / 2;
    const qtyA = Math.max(1, Math.floor(capitalPerLeg / priceA));
    const qtyB = Math.max(1, Math.floor(capitalPerLeg / priceB));

    // z > 0: A relativamente caro rispetto a B -> vende A (SHORT), compra B (LONG).
    const legA: EntryLeg = { symbol: stats.a, side: z > 0 ? "SHORT" : "LONG", qty: qtyA, entryPrice: priceA };
    const legB: EntryLeg = { symbol: stats.b, side: z > 0 ? "LONG" : "SHORT", qty: qtyB, entryPrice: priceB };

    candidates.push({ pairKey: key, legs: [legA, legB], z, absZ: Math.abs(z) });
  }

  candidates.sort((x, y) => y.absZ - x.absZ);
  return candidates.slice(0, freeSlots).map(({ absZ: _absZ, ...rest }) => rest);
}

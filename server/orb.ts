// Logica reale della strategia "Opening Range Breakout" (LAB A).
// Rompe il range dei primi 15 minuti sui titoli ad alta volatilità, long o short secondo
// il lato della rottura. Parametri presi da src/data/mockData.ts (STRATEGIES).

export const STRATEGY_ID = "orb";
export const MAX_POSITIONS = 6;
export const CAPITAL = 100_000;
export const OPENING_RANGE_MINUTES = 15;
export const ATR_THRESHOLD_PCT = 2;
// 2,5× dal 24/9/2026 (era 1,8×) — backtest A/B su due finestre indipendenti dopo la seduta
// whipsaw del 24/9 (13 ingressi, 12 stop, 1 target, -1.154 nel lab): una soglia più severa
// riduce gli ingressi (~440 -> 351/354) e migliora il P&L su entrambe le finestre
// (-1.472/-915 -> -870/-759) — ancora negativo, ma meno. 1,4× (più permissivo) è andato molto
// peggio (-7.597/-4.317), a conferma della direzione. Vedi CLAUDE.md.
export const VOLUME_MULTIPLE = 2.5;
export const STOP_LOSS_RANGE_MULT = 0.5;
export const TAKE_PROFIT_RANGE_MULT = 2.0;

export type Side = "LONG" | "SHORT";

export interface OpeningRange {
  high: number;
  low: number;
}

export interface DailyBar {
  t: string;
  h: number;
  l: number;
  c: number;
}

export interface IntradayBar {
  t: string;
  v: number;
}

export interface OpenPosition {
  id: number;
  symbol: string;
  side: Side;
  qty: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
}

export interface ExitDecision {
  position: OpenPosition;
  exitPrice: number;
  realizedPnl: number;
  reason: "stop" | "target";
}

export interface EntryDecision {
  symbol: string;
  side: Side;
  qty: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
}

/** ATR(period) come % del prezzo corrente, da barre giornaliere in ordine cronologico. */
export function computeATRPct(dailyBarsAscending: DailyBar[], period = 14): number | null {
  if (dailyBarsAscending.length < period + 1) return null;
  const trueRanges: number[] = [];
  for (let i = 1; i < dailyBarsAscending.length; i++) {
    const cur = dailyBarsAscending[i];
    const prevClose = dailyBarsAscending[i - 1].c;
    const tr = Math.max(cur.h - cur.l, Math.abs(cur.h - prevClose), Math.abs(cur.l - prevClose));
    trueRanges.push(tr);
  }
  const recent = trueRanges.slice(-period);
  const atr = recent.reduce((a, b) => a + b, 0) / recent.length;
  const lastClose = dailyBarsAscending[dailyBarsAscending.length - 1].c;
  return lastClose > 0 ? (atr / lastClose) * 100 : null;
}

/** Range di apertura (alto/basso) dalle prime OPENING_RANGE_MINUTES di barre a 5 min della seduta. */
export function computeOpeningRange(
  sessionBarsAscending: { h: number; l: number }[],
  /** Solo per backtest sperimentali (scripts/backtest.ts, EXP_ORB_RANGE_MINUTES) — default OPENING_RANGE_MINUTES, mai passato dai chiamanti reali. */
  openingRangeMinutesOverride: number = OPENING_RANGE_MINUTES
): OpeningRange | null {
  const barsNeeded = Math.ceil(openingRangeMinutesOverride / 5);
  if (sessionBarsAscending.length < barsNeeded) return null;
  const window = sessionBarsAscending.slice(0, barsNeeded);
  return {
    high: Math.max(...window.map((b) => b.h)),
    low: Math.min(...window.map((b) => b.l)),
  };
}

/** Chiude le posizioni che hanno toccato lo stop o il target. */
export function decideExits(openPositions: OpenPosition[], prices: Record<string, number>): ExitDecision[] {
  const decisions: ExitDecision[] = [];
  for (const pos of openPositions) {
    const price = prices[pos.symbol];
    if (price == null) continue;

    const stopHit = pos.side === "LONG" ? price <= pos.stopPrice : price >= pos.stopPrice;
    const targetHit = pos.side === "LONG" ? price >= pos.targetPrice : price <= pos.targetPrice;
    if (!stopHit && !targetHit) continue;

    const dir = pos.side === "LONG" ? 1 : -1;
    const realizedPnl = Math.round(pos.qty * (price - pos.entryPrice) * dir);
    decisions.push({ position: pos, exitPrice: price, realizedPnl, reason: targetHit ? "target" : "stop" });
  }
  return decisions;
}

export interface EntryInputs {
  price: number;
  openingRange: OpeningRange;
  atrPct: number;
  avgBarVolume: number;
  latestBarVolume: number;
}

/**
 * Decide le nuove posizioni da aprire: rottura del range di apertura, con filtro di
 * volatilità (ATR% minimo) e conferma di volume sulla barra di rottura. Ordina i
 * candidati per ampiezza della rottura (in % del range) e riempie gli slot liberi.
 */
export function decideEntries(
  universeSymbols: string[],
  openSymbols: Set<string>,
  inputsBySymbol: Record<string, EntryInputs>,
  freeSlots: number,
  /** Solo per backtest sperimentali (scripts/backtest.ts, EXP_ORB_VOLUME_MULT) — default VOLUME_MULTIPLE, mai passato dai chiamanti reali. */
  volumeMultipleOverride: number = VOLUME_MULTIPLE
): EntryDecision[] {
  if (freeSlots <= 0) return [];

  const candidates: (EntryDecision & { breakoutStrength: number })[] = [];
  for (const symbol of universeSymbols) {
    if (openSymbols.has(symbol)) continue;
    const inp = inputsBySymbol[symbol];
    if (!inp) continue;

    const { price, openingRange, atrPct, avgBarVolume, latestBarVolume } = inp;
    const rangeWidth = openingRange.high - openingRange.low;
    if (rangeWidth <= 0) continue;

    const brokeUp = price > openingRange.high;
    const brokeDown = price < openingRange.low;
    if (!brokeUp && !brokeDown) continue;

    if (atrPct < ATR_THRESHOLD_PCT) continue;
    if (avgBarVolume <= 0 || latestBarVolume < avgBarVolume * volumeMultipleOverride) continue;

    const side: Side = brokeUp ? "LONG" : "SHORT";
    const breakoutStrength = brokeUp
      ? (price - openingRange.high) / rangeWidth
      : (openingRange.low - price) / rangeWidth;

    candidates.push({
      symbol,
      side,
      qty: Math.max(1, Math.floor(CAPITAL / MAX_POSITIONS / price)),
      entryPrice: price,
      stopPrice: side === "LONG" ? price - STOP_LOSS_RANGE_MULT * rangeWidth : price + STOP_LOSS_RANGE_MULT * rangeWidth,
      targetPrice:
        side === "LONG" ? price + TAKE_PROFIT_RANGE_MULT * rangeWidth : price - TAKE_PROFIT_RANGE_MULT * rangeWidth,
      breakoutStrength,
    });
  }

  candidates.sort((a, b) => b.breakoutStrength - a.breakoutStrength);
  return candidates.slice(0, freeSlots).map(({ breakoutStrength: _breakoutStrength, ...rest }) => rest);
}

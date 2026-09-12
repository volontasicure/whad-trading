// Logica reale della strategia "VWAP reversion su momentum esaurito" (LAB C).
// Va contro le estensioni eccessive dal VWAP quando il momentum rallenta (RSI in ipercomprato/
// ipervenduto), target il ritorno alla media di giornata. Parametri presi da src/data/mockData.ts
// (STRATEGIES) — devono restare in sync se quei valori cambiano.

export const STRATEGY_ID = "vwap_reversion";
export const MAX_POSITIONS = 8;
export const CAPITAL = 100_000;
export const EXTENSION_THRESHOLD_PCT = 1.2;
export const RSI_PERIOD = 14;
export const RSI_OVERBOUGHT = 70;
export const RSI_OVERSOLD = 30;
export const STOP_LOSS_PCT = 0.6;
export const MAX_HOLD_MINUTES = 45;

export type Side = "LONG" | "SHORT";

export interface Snapshot {
  price: number;
  vwap: number;
}

export interface Bar {
  t: string;
  c: number;
}

export interface OpenPosition {
  id: number;
  symbol: string;
  side: Side;
  qty: number;
  entryPrice: number;
  entryTime: string;
}

export interface ExitDecision {
  position: OpenPosition;
  exitPrice: number;
  realizedPnl: number;
  reason: "target" | "stop_loss" | "max_hold";
}

export interface EntryDecision {
  symbol: string;
  side: Side;
  qty: number;
  entryPrice: number;
  distancePct: number;
  rsi: number;
}

/** RSI(14) su chiusure in ordine cronologico (crescente). Richiede almeno RSI_PERIOD+1 barre. */
export function computeRSI(closesAscending: number[], period = RSI_PERIOD): number | null {
  if (closesAscending.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  const start = closesAscending.length - period;
  for (let i = start; i < closesAscending.length; i++) {
    const delta = closesAscending[i] - closesAscending[i - 1];
    if (delta > 0) gains += delta;
    else losses += -delta;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function unrealizedPct(side: Side, entryPrice: number, price: number): number {
  return side === "LONG" ? ((price - entryPrice) / entryPrice) * 100 : ((entryPrice - price) / entryPrice) * 100;
}

/**
 * Decide quali posizioni aperte vanno chiuse ora: target raggiunto (rientro sul VWAP),
 * stop loss, o tempo massimo in posizione superato. Posizioni per simboli senza uno
 * snapshot valido restano aperte (dato mancante, non si agisce alla cieca).
 */
export function decideExits(
  openPositions: OpenPosition[],
  snapshots: Record<string, Snapshot>,
  now: Date
): ExitDecision[] {
  const decisions: ExitDecision[] = [];
  for (const pos of openPositions) {
    const snap = snapshots[pos.symbol];
    if (!snap) continue;

    const holdMinutes = (now.getTime() - new Date(pos.entryTime).getTime()) / 60_000;
    const pct = unrealizedPct(pos.side, pos.entryPrice, snap.price);

    const targetReached = pos.side === "LONG" ? snap.price >= snap.vwap : snap.price <= snap.vwap;
    const stopHit = pct <= -STOP_LOSS_PCT;
    const timeUp = holdMinutes >= MAX_HOLD_MINUTES;

    if (!targetReached && !stopHit && !timeUp) continue;

    const dir = pos.side === "LONG" ? 1 : -1;
    const realizedPnl = Math.round(pos.qty * (snap.price - pos.entryPrice) * dir);
    decisions.push({
      position: pos,
      exitPrice: snap.price,
      realizedPnl,
      reason: targetReached ? "target" : stopHit ? "stop_loss" : "max_hold",
    });
  }
  return decisions;
}

/**
 * Decide quali nuove posizioni aprire per riempire gli slot liberi (fino a MAX_POSITIONS
 * totali tra quelle già aperte e quelle nuove). Equal-weight sul massimo di posizioni della
 * strategia (CAPITAL / MAX_POSITIONS), non sull'intero universo — così il laboratorio
 * dispiega tutto il capitale quando è a pieno regime, invece di lasciarne inutilizzato.
 */
export function decideEntries(
  universeSymbols: string[],
  openSymbols: Set<string>,
  snapshots: Record<string, Snapshot>,
  barsBySymbol: Record<string, Bar[]>,
  freeSlots: number
): EntryDecision[] {
  if (freeSlots <= 0) return [];

  const candidates: EntryDecision[] = [];
  for (const symbol of universeSymbols) {
    if (openSymbols.has(symbol)) continue;
    const snap = snapshots[symbol];
    const bars = barsBySymbol[symbol];
    if (!snap || !bars || bars.length === 0) continue;

    const closesAscending = [...bars].sort((a, b) => a.t.localeCompare(b.t)).map((b) => b.c);
    const rsi = computeRSI(closesAscending);
    if (rsi == null) continue;

    const distancePct = ((snap.price - snap.vwap) / snap.vwap) * 100;
    if (Math.abs(distancePct) < EXTENSION_THRESHOLD_PCT) continue;

    const exhausted = distancePct > 0 ? rsi > RSI_OVERBOUGHT : rsi < RSI_OVERSOLD;
    if (!exhausted) continue;

    candidates.push({
      symbol,
      side: distancePct > 0 ? "SHORT" : "LONG",
      qty: Math.max(1, Math.floor(CAPITAL / MAX_POSITIONS / snap.price)),
      entryPrice: snap.price,
      distancePct,
      rsi,
    });
  }

  candidates.sort((a, b) => Math.abs(b.distancePct) - Math.abs(a.distancePct));
  return candidates.slice(0, freeSlots);
}

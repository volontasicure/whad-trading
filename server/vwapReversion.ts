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
// 90 minuti dal 24/9/2026 (era 45) — backtest A/B su due finestre indipendenti: sullo storico
// completo il bucket max_hold era l'unico lievemente positivo (+692 netto su 43 trade),
// segno che il segnale d'ingresso ha un margine ma veniva tagliato prima di potersi
// esprimere. A 90 minuti i target raggiunti nella finestra recente passano da ~5 a 17 (molte
// posizioni arrivano al rientro sul VWAP invece di uscire a tempo scaduto) — P&L da 2.231/999
// a 2.248/1.463, migliora su entrambe le finestre (marcato fuori campione, +46%). 60 minuti è
// misto (non adottato). Vedi CLAUDE.md.
export const MAX_HOLD_MINUTES = 90;
/**
 * Filtro di trend di fondo (media mobile + Efficiency Ratio di Kaufman, server/
 * technicalIndicators.ts): non scommettere sul ritorno al VWAP contro un titolo che è già in
 * un trend pulito nella direzione opposta alla scommessa — es. non comprare aspettando un
 * rimbalzo se il titolo è sotto la propria media mobile con un ribasso direzionale vero, non
 * rumore. Aggiunto dopo il 16/9/2026: BA rientrata 5 volte consecutive in mean-reversion
 * mentre scendeva in un trend reale (confermato a posteriori con lo stesso filtro sulla
 * breakdown ladder short — CAT/HON/GE, stesso settore di BA, erano risultati i migliori
 * proprio perché in un ribasso pulito quel giorno). Parametri indipendenti da quelli della
 * ladder (stesso punto di partenza, potranno essere tarati separatamente).
 */
export const TREND_FILTER_DAYS = 20;
export const MIN_TREND_EFFICIENCY = 0.3;

export interface TrendContext {
  sma: number;
  efficiency: number;
}

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
  now: Date,
  /** Solo per backtest sperimentali (scripts/backtest.ts, EXP_VWAP_STOP_PCT) — default STOP_LOSS_PCT, mai passato dai chiamanti reali. */
  stopLossPctOverride: number = STOP_LOSS_PCT,
  /** Solo per backtest sperimentali (scripts/backtest.ts, EXP_VWAP_MAX_HOLD_MIN) — default MAX_HOLD_MINUTES, mai passato dai chiamanti reali. */
  maxHoldMinutesOverride: number = MAX_HOLD_MINUTES
): ExitDecision[] {
  const decisions: ExitDecision[] = [];
  for (const pos of openPositions) {
    const snap = snapshots[pos.symbol];
    if (!snap) continue;

    const holdMinutes = (now.getTime() - new Date(pos.entryTime).getTime()) / 60_000;
    const pct = unrealizedPct(pos.side, pos.entryPrice, snap.price);

    const targetReached = pos.side === "LONG" ? snap.price >= snap.vwap : snap.price <= snap.vwap;
    const stopHit = pct <= -stopLossPctOverride;
    const timeUp = holdMinutes >= maxHoldMinutesOverride;

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
 *
 * trendBySymbol (giornaliero, calcolato dal chiamante): filtro di trend — vedi TrendContext
 * sopra. Default {} per compatibilità, ma va sempre popolato dai chiamanti reali.
 */
export function decideEntries(
  universeSymbols: string[],
  openSymbols: Set<string>,
  snapshots: Record<string, Snapshot>,
  barsBySymbol: Record<string, Bar[]>,
  freeSlots: number,
  trendBySymbol: Record<string, TrendContext> = {},
  /** Solo per backtest sperimentali (scripts/backtest.ts, EXP_VWAP_EXTENSION_PCT) — default EXTENSION_THRESHOLD_PCT, mai passato dai chiamanti reali. */
  extensionThresholdPctOverride: number = EXTENSION_THRESHOLD_PCT
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
    if (Math.abs(distancePct) < extensionThresholdPctOverride) continue;

    const exhausted = distancePct > 0 ? rsi > RSI_OVERBOUGHT : rsi < RSI_OVERSOLD;
    if (!exhausted) continue;

    // Filtro di trend: non scommettere sul ritorno alla media contro un trend di fondo pulito
    // nella direzione opposta alla scommessa (prezzo sopra VWAP + già in rialzo pulito -> non
    // shortare; prezzo sotto VWAP + già in ribasso pulito -> non comprare, caso BA 16/9).
    const trend = trendBySymbol[symbol];
    if (trend && trend.efficiency >= MIN_TREND_EFFICIENCY) {
      if (distancePct > 0 && snap.price > trend.sma) continue;
      if (distancePct < 0 && snap.price < trend.sma) continue;
    }

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

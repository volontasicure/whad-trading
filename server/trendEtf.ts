// LAB D — Trend ETF (21/10/2026). Logica PURA (nessun I/O): segnali, pesi target e decisione di
// ribilanciamento. L'esecutore con le letture Alpaca/DB è server/trendRunner.ts.
//
// Perché esiste: dopo la correzione della censura a destra (CLAUDE.md, "Correzione metodologica e
// revisione da trader"), il pairs da solo rende ~3,5%/anno senza leva. Il trend following sui 12 ETF
// liquidi, provato su 9,7 anni di barre giornaliere (scripts/trend-test.mjs, variante S4), dà 7,0%/anno,
// Sharpe 0,98, drawdown 9,9% con un plateau robusto sui parametri vicini, ed è scorrelato dal pairs
// (−0,04). È in gran parte beta (premio al rischio) gestito per limitare il drawdown, non alpha: vedi i
// limiti dichiarati in CLAUDE.md.
//
// Regole (identiche al backtest S4, fissate prima di vedere i risultati e non tarate):
//   - segnale per ETF: ultima chiusura sopra la media semplice a 200 sedute → long, altrimenti liquidità;
//   - pesi inversi alla volatilità a 63 sedute, scalati perché la volatilità di portafoglio stimata
//     (covarianza a 63 sedute) sia il 10% annuo; esposizione lorda massima 100% (nessuna leva);
//   - ribilanciamento una volta al mese, alla prima seduta del mese (e alla prima esecuzione in assoluto),
//     sulle chiusure fino alla seduta precedente; solo long, mai short.
// Differenza dal backtest, dichiarata: le righe di lab_positions non si ritoccano, quindi una posizione la cui
// quantità target è entro ±REBALANCE_BAND di quella attuale NON viene toccata (niente costi inutili); una
// variazione oltre la banda chiude la riga e ne apre una nuova alla quantità target. Il costo del lab
// (server/costs.ts) si applica al nozionale intero di ogni riga chiusa, quindi è leggermente prudente.

export const STRATEGY_ID = "trend";
export const TREND_SYMBOLS = ["SPY", "QQQ", "IWM", "EFA", "EEM", "VNQ", "TLT", "IEF", "LQD", "GLD", "DBC", "UUP"] as const;
export const SMA_DAYS = 200;
export const VOL_WINDOW = 63;
/** Volatilità annua di portafoglio cercata. */
export const TARGET_VOL = 0.1;
/** Somma dei pesi assoluti massima: 1 = nessuna leva. */
export const MAX_GROSS = 1.0;
export const CAPITAL = 100_000;
/** Chiusure giornaliere minime per usare un ETF (SMA200 + finestra di volatilità + margine). */
export const MIN_HISTORY = 260;
export const REBALANCE_BAND = 0.2;

export interface EtfSignal {
  symbol: string;
  close: number;
  sma: number;
  above: boolean;
  /** Volatilità annualizzata sulle ultime VOL_WINDOW sedute. */
  vol: number;
}

export interface TargetPlan {
  weights: Record<string, number>;
  signals: Record<string, EtfSignal>;
  portfolioVol: number;
  gross: number;
}

function stdev(x: number[]): number {
  const m = x.reduce((a, b) => a + b, 0) / x.length;
  return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / x.length);
}

function covariance(x: number[], y: number[]): number {
  const mx = x.reduce((a, b) => a + b, 0) / x.length;
  const my = y.reduce((a, b) => a + b, 0) / y.length;
  let s = 0;
  for (let i = 0; i < x.length; i++) s += (x[i] - mx) * (y[i] - my);
  return s / x.length;
}

function dailyReturns(closes: number[]): number[] {
  const r: number[] = [];
  for (let i = closes.length - VOL_WINDOW; i < closes.length; i++) r.push(closes[i] / closes[i - 1] - 1);
  return r;
}

/** Segnale e volatilità per ogni ETF con storico sufficiente; gli altri non compaiono. `closes` = chiusure in ordine cronologico, fino all'ultima seduta COMPLETA. */
export function computeSignals(closes: Record<string, number[]>): Record<string, EtfSignal> {
  const out: Record<string, EtfSignal> = {};
  for (const symbol of TREND_SYMBOLS) {
    const c = closes[symbol];
    if (!c || c.length < MIN_HISTORY) continue;
    const last = c[c.length - 1];
    const sma = c.slice(-SMA_DAYS).reduce((a, b) => a + b, 0) / SMA_DAYS;
    const vol = stdev(dailyReturns(c)) * Math.sqrt(252);
    out[symbol] = { symbol, close: last, sma, above: last > sma, vol };
  }
  return out;
}

/** Pesi target (frazioni dell'equity) per gli ETF sopra la media, inversi alla volatilità e scalati sul target di portafoglio. */
export function computeTargetWeights(closes: Record<string, number[]>): TargetPlan {
  const signals = computeSignals(closes);
  const active = Object.values(signals).filter((s) => s.above && s.vol > 0);
  const weights: Record<string, number> = {};
  for (const symbol of TREND_SYMBOLS) weights[symbol] = 0;
  if (active.length === 0) return { weights, signals, portfolioVol: 0, gross: 0 };

  const raw: Record<string, number> = {};
  for (const s of active) raw[s.symbol] = 1 / s.vol;
  const rets: Record<string, number[]> = {};
  for (const s of active) rets[s.symbol] = dailyReturns(closes[s.symbol]);

  let variance = 0;
  for (const a of active) for (const b of active) variance += raw[a.symbol] * raw[b.symbol] * covariance(rets[a.symbol], rets[b.symbol]) * 252;
  const pv = Math.sqrt(Math.max(variance, 1e-12));
  const k = TARGET_VOL / pv;
  let gross = 0;
  for (const s of active) {
    weights[s.symbol] = raw[s.symbol] * k;
    gross += weights[s.symbol];
  }
  let estimatedVol = TARGET_VOL;
  if (gross > MAX_GROSS) {
    for (const s of active) weights[s.symbol] = (weights[s.symbol] * MAX_GROSS) / gross;
    estimatedVol = (TARGET_VOL * MAX_GROSS) / gross;
    gross = MAX_GROSS;
  }
  return { weights, signals, portfolioVol: estimatedVol, gross };
}

export interface TrendPosition {
  id: number;
  symbol: string;
  qty: number;
  entryPrice: number;
}

export interface RebalanceDecision {
  closes: { id: number; symbol: string; exitPrice: number; realizedPnl: number }[];
  opens: { symbol: string; qty: number; price: number }[];
}

/** Quali righe chiudere e quali aprire per portare il lab ai pesi target, con la banda di tolleranza. */
export function decideRebalance(
  plan: TargetPlan,
  equity: number,
  prices: Record<string, number>,
  open: TrendPosition[],
  band: number = REBALANCE_BAND
): RebalanceDecision {
  const decision: RebalanceDecision = { closes: [], opens: [] };
  for (const symbol of TREND_SYMBOLS) {
    const price = prices[symbol];
    if (price == null || !(price > 0)) continue;
    const rows = open.filter((p) => p.symbol === symbol);
    const current = rows.reduce((s, r) => s + r.qty, 0);
    const target = Math.max(0, Math.floor(((plan.weights[symbol] ?? 0) * equity) / price));
    // Un ETF senza segnale/storico non ha peso: si esce. Con segnale, si tocca solo oltre la banda.
    const unchanged = current > 0 && target > 0 && Math.abs(target - current) / current <= band;
    if (unchanged || (current === 0 && target === 0)) continue;
    for (const r of rows) decision.closes.push({ id: r.id, symbol, exitPrice: price, realizedPnl: Math.round(r.qty * (price - r.entryPrice)) });
    if (target > 0) decision.opens.push({ symbol, qty: target, price });
  }
  return decision;
}

/** Mese di calendario ("YYYY-MM") della data ET/UTC di una seduta: si ribilancia quando cambia. */
export function monthOf(dateIso: string): string {
  return dateIso.slice(0, 7);
}

export function isRebalanceDue(lastRebalanceMonth: string | null, todayIso: string): boolean {
  return lastRebalanceMonth !== monthOf(todayIso);
}

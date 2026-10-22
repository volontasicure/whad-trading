// LAB D (trend ETF, dal 21/10/2026) e LAB E (rotazione ETF, dal 22/10/2026): le due metà del CORE del portafoglio
// proposto il 22/10/2026 (CLAUDE.md, "Ridisegno integrale"). Logica PURA (nessun I/O): segnali, pesi target e
// decisione di ribilanciamento. L'esecutore con le letture Alpaca/DB è server/trendRunner.ts.
//
// Perché esiste: su 10 anni di backtest di produzione (scripts/redesign-test.ts) ORB, VWAP e il pairs senza stop a
// tempo perdono, e il pairs con lo stop a tempo rende quanto i T-bill. Il CORE (50% trend + 50% rotazione sui 12 ETF,
// liquidità in T-bill, parametri ricalibrati ogni anno in walk-forward) con il pairs sovrapposto 1× ha dato, fuori
// campione 2019-2026, 13,8%/anno, Sharpe in eccesso dei T-bill 1,10, drawdown 11,4%. È in gran parte premio al
// rischio gestito (correlazione con SPY 0,53), non alpha: vedi i limiti dichiarati in CLAUDE.md.
//
// Regole (identiche a runEtf/trendWeights/rotationWeights di scripts/redesign-test.ts):
//   TREND (LAB D)    ETF long se l'ultima chiusura è sopra la media semplice a `smaDays` sedute; pesi inversi alla
//                    volatilità a 63 sedute, scalati perché la volatilità di portafoglio stimata (covarianza a 63
//                    sedute) sia `targetVol`; esposizione massima 100%.
//   ROTAZIONE (LAB E) punteggio = media dei rendimenti a `months` mesi (21 sedute ciascuno); si tengono i `topK` ETF
//                    col punteggio migliore, solo se battono quello dei T-bill (BIL), a peso 1/topK ciascuno.
//   Entrambi: la quota non investita va in BIL (T-bill 1-3 mesi) invece di restare a rendimento zero; solo long, mai
//   leva; ribilanciamento alla prima seduta di ogni mese (e alla prima esecuzione, e quando cambiano i parametri) sulle
//   chiusure fino alla seduta precedente.
// Differenza dal backtest, dichiarata: le righe di lab_positions non si ritoccano, quindi una posizione la cui
// quantità target è entro ±REBALANCE_BAND di quella attuale NON viene toccata (niente costi inutili); una variazione
// oltre la banda chiude la riga e ne apre una nuova. Il costo del lab (server/costs.ts) si applica al nozionale intero
// di ogni riga chiusa, quindi è leggermente prudente.

export const STRATEGY_ID = "trend";
export const ROTATION_STRATEGY_ID = "rotation";
/** Lab ETF: posizioni tenute settimane, mai chiuse dalla regola EOD delle posizioni singole. */
export const ETF_LAB_STRATEGY_IDS: readonly string[] = [STRATEGY_ID, ROTATION_STRATEGY_ID];
export const TREND_SYMBOLS = ["SPY", "QQQ", "IWM", "EFA", "EEM", "VNQ", "TLT", "IEF", "LQD", "GLD", "DBC", "UUP"] as const;
/** Dove si parcheggia la quota non investita (T-bill 1-3 mesi). */
export const CASH_SYMBOL = "BIL";
export const ALL_SYMBOLS: readonly string[] = [...TREND_SYMBOLS, CASH_SYMBOL];
export const VOL_WINDOW = 63;
/** Somma dei pesi assoluti massima: 1 = nessuna leva. */
export const MAX_GROSS = 1.0;
export const CAPITAL = 100_000;
/** Chiusure giornaliere minime per usare un ETF: 12 mesi di momentum (253) + margine; copre anche media e volatilità. */
export const MIN_HISTORY = 260;
export const REBALANCE_BAND = 0.2;

export interface TrendParams {
  smaDays: number;
  targetVol: number;
}
export interface RotationParams {
  months: number[];
  topK: number;
}

/**
 * Parametri dell'anno, scelti in WALK-FORWARD: la combinazione con lo Sharpe in eccesso dei T-bill migliore su tutti i
 * dati precedenti (2017 → fine dell'anno prima), su griglie fisse — trend: media 100/150/200/250 × vol 8/10/12%;
 * rotazione: 3/6/12 mesi o media 1-3-6-12 × top 2/3/4/5. Scelte per il 2026 (scripts/redesign-test.ts, "Scelte
 * walk-forward"): trend SMA150/vol12 (la stessa dal 2021), rotazione "mix top5" (la stessa dal 2022).
 * RICALIBRAZIONE: ogni gennaio rilanciare `npx tsx scripts/redesign-test.ts` con i dati aggiornati, leggere le scelte
 * dell'anno nuovo e aggiornare qui `version` e i parametri (il cambio di `version` fa ribilanciare i lab al tick dopo).
 * Mai ritoccarli a metà anno per inseguire un risultato.
 */
export const CORE_PARAMS: { version: string; trend: TrendParams; rotation: RotationParams } = {
  version: "wf-2026",
  trend: { smaDays: 150, targetVol: 0.12 },
  rotation: { months: [1, 3, 6, 12], topK: 5 },
};

export interface EtfSignal {
  symbol: string;
  close: number;
  sma: number;
  above: boolean;
  /** Volatilità annualizzata sulle ultime VOL_WINDOW sedute. */
  vol: number;
}

export interface RotationScore {
  symbol: string;
  /** Media dei rendimenti sui mesi di CORE_PARAMS.rotation.months. */
  score: number;
  rank: number;
  selected: boolean;
}

export interface TargetPlan {
  /** Pesi (frazioni dell'equity) su ALL_SYMBOLS; BIL raccoglie la quota non investita. */
  weights: Record<string, number>;
  signals: Record<string, EtfSignal>;
  /** Solo rotazione: punteggio e posizione in classifica di ogni ETF, più il riferimento dei T-bill. */
  scores?: Record<string, RotationScore>;
  cashScore?: number;
  portfolioVol: number;
  /** Esposizione sugli ETF di rischio (BIL escluso). */
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

function emptyWeights(): Record<string, number> {
  return Object.fromEntries(ALL_SYMBOLS.map((s) => [s, 0]));
}

/** Segnale e volatilità per ogni ETF con storico sufficiente; gli altri non compaiono. `closes` = chiusure in ordine cronologico, fino all'ultima seduta COMPLETA. */
export function computeSignals(closes: Record<string, number[]>, smaDays: number = CORE_PARAMS.trend.smaDays): Record<string, EtfSignal> {
  const out: Record<string, EtfSignal> = {};
  for (const symbol of TREND_SYMBOLS) {
    const c = closes[symbol];
    if (!c || c.length < MIN_HISTORY) continue;
    const last = c[c.length - 1];
    const sma = c.slice(-smaDays).reduce((a, b) => a + b, 0) / smaDays;
    const vol = stdev(dailyReturns(c)) * Math.sqrt(252);
    out[symbol] = { symbol, close: last, sma, above: last > sma, vol };
  }
  return out;
}

/** TREND: pesi per gli ETF sopra la media, inversi alla volatilità e scalati sul target di portafoglio; il resto in BIL. */
export function computeTargetWeights(closes: Record<string, number[]>, params: TrendParams = CORE_PARAMS.trend): TargetPlan {
  const signals = computeSignals(closes, params.smaDays);
  const active = Object.values(signals).filter((s) => s.above && s.vol > 0);
  const weights = emptyWeights();
  let gross = 0;
  let estimatedVol = 0;
  if (active.length > 0) {
    const raw: Record<string, number> = {};
    for (const s of active) raw[s.symbol] = 1 / s.vol;
    const rets: Record<string, number[]> = {};
    for (const s of active) rets[s.symbol] = dailyReturns(closes[s.symbol]);
    let variance = 0;
    for (const a of active) for (const b of active) variance += raw[a.symbol] * raw[b.symbol] * covariance(rets[a.symbol], rets[b.symbol]) * 252;
    const k = params.targetVol / Math.sqrt(Math.max(variance, 1e-12));
    for (const s of active) {
      weights[s.symbol] = raw[s.symbol] * k;
      gross += weights[s.symbol];
    }
    estimatedVol = params.targetVol;
    if (gross > MAX_GROSS) {
      for (const s of active) weights[s.symbol] = (weights[s.symbol] * MAX_GROSS) / gross;
      estimatedVol = (params.targetVol * MAX_GROSS) / gross;
      gross = MAX_GROSS;
    }
  }
  if ((closes[CASH_SYMBOL]?.length ?? 0) > 0) weights[CASH_SYMBOL] = Math.max(0, 1 - gross);
  return { weights, signals, portfolioVol: estimatedVol, gross };
}

function momentum(c: number[], months: number[]): number | null {
  const parts: number[] = [];
  for (const m of months) {
    const back = c.length - 1 - 21 * m;
    if (back < 0) return null;
    parts.push(c[c.length - 1] / c[back] - 1);
  }
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

/** ROTAZIONE: i topK ETF col momentum migliore, solo se battono i T-bill, a peso 1/topK; il resto in BIL. */
export function computeRotationWeights(closes: Record<string, number[]>, params: RotationParams = CORE_PARAMS.rotation): TargetPlan {
  const signals = computeSignals(closes);
  const weights = emptyWeights();
  const cashScore = closes[CASH_SYMBOL] ? momentum(closes[CASH_SYMBOL], params.months) : null;
  const ranked = TREND_SYMBOLS.filter((s) => (closes[s]?.length ?? 0) >= MIN_HISTORY)
    .map((symbol) => ({ symbol, score: momentum(closes[symbol], params.months) }))
    .filter((x): x is { symbol: (typeof TREND_SYMBOLS)[number]; score: number } => x.score != null)
    .sort((a, b) => b.score - a.score);
  const scores: Record<string, RotationScore> = {};
  let gross = 0;
  ranked.forEach((x, i) => {
    // senza il riferimento dei T-bill non si compra nulla: meglio liquidità che un filtro assoluto mancante
    const selected = i < params.topK && cashScore != null && x.score > cashScore;
    scores[x.symbol] = { symbol: x.symbol, score: x.score, rank: i + 1, selected };
    if (selected) {
      weights[x.symbol] = 1 / params.topK;
      gross += 1 / params.topK;
    }
  });
  if ((closes[CASH_SYMBOL]?.length ?? 0) > 0) weights[CASH_SYMBOL] = Math.max(0, 1 - gross);
  return { weights, signals, scores, cashScore: cashScore ?? undefined, portfolioVol: 0, gross };
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
  for (const symbol of ALL_SYMBOLS) {
    const price = prices[symbol];
    if (price == null || !(price > 0)) continue;
    const rows = open.filter((p) => p.symbol === symbol);
    const current = rows.reduce((s, r) => s + r.qty, 0);
    const target = Math.max(0, Math.floor(((plan.weights[symbol] ?? 0) * equity) / price));
    // Un ETF senza peso: si esce. Con peso, si tocca solo oltre la banda.
    const unchanged = current > 0 && target > 0 && Math.abs(target - current) / current <= band;
    if (unchanged || (current === 0 && target === 0)) continue;
    for (const r of rows) decision.closes.push({ id: r.id, symbol, exitPrice: price, realizedPnl: Math.round(r.qty * (price - r.entryPrice)) });
    if (target > 0) decision.opens.push({ symbol, qty: target, price });
  }
  return decision;
}

/** Mese di calendario ("YYYY-MM") della data di una seduta: si ribilancia quando cambia. */
export function monthOf(dateIso: string): string {
  return dateIso.slice(0, 7);
}

/** Dovuto alla prima esecuzione, al cambio di mese e al cambio di versione dei parametri (ricalibrazione annuale). */
export function isRebalanceDue(lastRebalanceMonth: string | null, todayIso: string, lastVersion?: string | null, version: string = CORE_PARAMS.version): boolean {
  if (lastRebalanceMonth !== monthOf(todayIso)) return true;
  return lastVersion !== undefined && lastVersion !== version;
}

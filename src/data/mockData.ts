import type {
  BrokerStatus,
  Debrief,
  Execution,
  PeriodPnl,
  Portfolio,
  Position,
  Session,
  SessionRules,
  Side,
  Strategy,
  StrategyId,
} from "../types";

export const CAPITAL = 100_000;

export const COLOR_POS = "#15803d";
export const COLOR_NEG = "#b91c1c";
export const COLOR_NEUTRAL = "#57544d";

/** Formatta un importo con segno, senza decimali, separatore delle migliaia it-IT. */
export function money(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return sign + Math.round(Math.abs(n)).toLocaleString("it-IT");
}

/** Colore semantico per un valore di P&L. */
export function pnlColor(n: number): string {
  return n > 0 ? COLOR_POS : n < 0 ? COLOR_NEG : COLOR_NEUTRAL;
}

/** Numero decimale in formato it-IT con d cifre. */
export function dec(n: number, d: number): string {
  return n.toLocaleString("it-IT", { minimumFractionDigits: d, maximumFractionDigits: d });
}

export type PnlMode = "abs" | "pct";

/** Formatta un P&L come valore assoluto o come percentuale sul capitale, secondo il toggle condiviso. */
export function formatPnl(n: number, mode: PnlMode, capital = CAPITAL): string {
  if (mode === "abs") return money(n);
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return sign + dec((Math.abs(n) / capital) * 100, 2) + "%";
}

/** Hash deterministico [0,1) usato per derivare dati finti ma stabili dai simboli. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

export interface MarketRow {
  symbol: string;
  name: string;
  price: number;
  changePct: number;
}

/**
 * Prezzo e variazione % di fallback — usati quando le quotazioni reali di Alpaca
 * non sono disponibili (chiavi non configurate, fetch fallito). L'universo di
 * simboli/nomi qui definito resta fisso: solo prezzo/variazione vengono
 * sovrascritti con dati reali in `buildLiveMarketData`.
 */
export const MARKET: MarketRow[] = [
  { symbol: "AAPL", name: "Apple", price: 234.34, changePct: 1.24 },
  { symbol: "MSFT", name: "Microsoft", price: 418.75, changePct: 0.62 },
  { symbol: "NVDA", name: "Nvidia", price: 129.6, changePct: 2.81 },
  { symbol: "GOOGL", name: "Alphabet", price: 178.9, changePct: 0.88 },
  { symbol: "META", name: "Meta", price: 566.2, changePct: 1.65 },
  { symbol: "TXN", name: "Texas Instruments", price: 197.4, changePct: 1.86 },
  { symbol: "AVGO", name: "Broadcom", price: 168.5, changePct: 1.1 },
  { symbol: "ORCL", name: "Oracle", price: 178.2, changePct: 0.75 },
  { symbol: "CRM", name: "Salesforce", price: 258.4, changePct: -0.35 },
  { symbol: "JPM", name: "JP Morgan", price: 241.15, changePct: -0.31 },
  { symbol: "BAC", name: "Bank of America", price: 46.82, changePct: 0.24 },
  { symbol: "V", name: "Visa", price: 288.35, changePct: 0.44 },
  { symbol: "MA", name: "Mastercard", price: 512.6, changePct: 0.38 },
  { symbol: "WFC", name: "Wells Fargo", price: 74.2, changePct: 0.15 },
  { symbol: "GS", name: "Goldman Sachs", price: 560.1, changePct: 0.52 },
  { symbol: "XOM", name: "Exxon", price: 116.3, changePct: -1.12 },
  { symbol: "CVX", name: "Chevron", price: 154.7, changePct: -0.86 },
  { symbol: "COP", name: "ConocoPhillips", price: 104.5, changePct: -0.6 },
  { symbol: "SLB", name: "Schlumberger", price: 44.8, changePct: -0.95 },
  { symbol: "KO", name: "Coca-Cola", price: 66.45, changePct: 0.18 },
  { symbol: "PEP", name: "PepsiCo", price: 148.2, changePct: -0.22 },
  { symbol: "PG", name: "Procter & Gamble", price: 169.8, changePct: 0.12 },
  { symbol: "WMT", name: "Walmart", price: 84.3, changePct: 0.4 },
  { symbol: "COST", name: "Costco", price: 920.5, changePct: 0.66 },
  { symbol: "UNH", name: "UnitedHealth", price: 512.8, changePct: 1.04 },
  { symbol: "JNJ", name: "Johnson & Johnson", price: 161.35, changePct: 0.36 },
  { symbol: "ABBV", name: "AbbVie", price: 178.9, changePct: 0.5 },
  { symbol: "LLY", name: "Eli Lilly", price: 780.4, changePct: 1.2 },
  { symbol: "MRK", name: "Merck", price: 102.6, changePct: -0.28 },
  { symbol: "TMO", name: "Thermo Fisher", price: 540.2, changePct: 0.45 },
  { symbol: "CAT", name: "Caterpillar", price: 368.2, changePct: 1.42 },
  { symbol: "HON", name: "Honeywell", price: 214.6, changePct: 0.54 },
  { symbol: "LIN", name: "Linde", price: 452.1, changePct: -0.18 },
  { symbol: "BA", name: "Boeing", price: 178.3, changePct: -0.75 },
  { symbol: "GE", name: "GE Aerospace", price: 176.4, changePct: 0.9 },
  { symbol: "AMZN", name: "Amazon", price: 201.45, changePct: -0.42 },
  { symbol: "HD", name: "Home Depot", price: 398.6, changePct: 0.33 },
  { symbol: "MCD", name: "McDonald's", price: 296.7, changePct: -0.15 },
  { symbol: "NKE", name: "Nike", price: 78.9, changePct: -0.55 },
  { symbol: "SBUX", name: "Starbucks", price: 96.4, changePct: 0.28 },
];

export const STRATEGIES: Strategy[] = [
  {
    id: "orb",
    code: "LAB A",
    name: "Opening Range Breakout (ORB)",
    shortName: "ORB alta volatilità",
    logic:
      "Rompe il range dei primi 15 minuti sui titoli ad alta volatilità, long o short secondo il lato della rottura.",
    note: "Poche operazioni molto direzionali: forte nei giorni con gap e volumi, piatta nelle sedute compresse.",
    maxPositions: 6,
    params: [
      { label: "Range di apertura", value: "15 min", hint: "finestra che definisce i livelli di rottura" },
      { label: "Filtro volatilità", value: "ATR > 2%", hint: "solo i titoli più mobili dell'universo" },
      { label: "Conferma volume", value: "1,8× medio", hint: "volume minimo sulla candela di rottura" },
      { label: "Stop loss", value: "0,5× range", hint: "metà dell'ampiezza del range di apertura" },
      { label: "Take profit", value: "2,0× range", hint: "target simmetrico al rischio assunto" },
      { label: "Titoli max in portafoglio", value: "6 / 20", hint: "solo le rotture più ampie" },
    ],
    backtest: {
      net: 5860,
      sharpe: 0.96,
      winRate: 0.44,
      tradesPerSession: 12,
      costs: 84,
      profitFactor: 2.1,
      dailyPnl: [-210, 640, 180, -320, 920, -180, 410, 1120, -260, 380, -140, 760, 540, -410, 880, 220, -190, 1040, 360, 1310],
    },
  },
  {
    id: "pairs",
    code: "LAB B",
    name: "Statistical arbitrage / pairs trading",
    shortName: "Pairs trading",
    logic:
      "Coppie cointegrate dello stesso settore: compra il titolo debole e vende quello forte quando lo spread supera 2σ, chiude sul rientro alla media.",
    note: "Market neutral e molto stabile, poco esposta al mercato, ma erosa dai costi della doppia gamba.",
    maxPositions: 20,
    params: [
      { label: "Coppie attive", value: "10", hint: "una gamba long e una short per coppia" },
      { label: "Ingresso sullo spread", value: "±2,0σ", hint: "z-score su finestra mobile di 60 minuti" },
      { label: "Uscita", value: "0,3σ", hint: "rientro verso la media dello spread" },
      { label: "Stop sullo spread", value: "3,5σ", hint: "rottura della relazione tra i due titoli" },
      { label: "Ricalcolo cointegrazione", value: "giornaliero", hint: "coppie riverificate prima dell'apertura" },
      { label: "Esposizione netta", value: "≈ 0%", hint: "capitale diviso a metà tra long e short" },
    ],
    backtest: {
      net: 4310,
      sharpe: 1.58,
      winRate: 0.68,
      tradesPerSession: 40,
      costs: 236,
      profitFactor: 1.74,
      dailyPnl: [180, 240, -80, 310, 190, 270, -120, 220, 360, 140, 290, -60, 330, 210, 180, 400, 90, -110, 260, 340],
    },
  },
  {
    id: "vwap_reversion",
    code: "LAB C",
    name: "VWAP reversion su momentum esaurito",
    shortName: "VWAP reversion",
    logic:
      "Va contro le estensioni eccessive dal VWAP quando il momentum rallenta, con target il ritorno alla media di giornata.",
    note: "Win rate alto e operazioni brevi, ma soffre le giornate a trend continuo che non tornano sul VWAP.",
    maxPositions: 8,
    params: [
      { label: "Distanza dal VWAP", value: "≥ 1,2%", hint: "soglia di estensione per entrare contro" },
      { label: "Filtro esaurimento", value: "RSI 14 > 70 / < 30", hint: "conferma di momentum in rallentamento" },
      { label: "Target", value: "VWAP", hint: "chiusura al ritorno sulla media di giornata" },
      { label: "Stop loss", value: "−0,6%", hint: "oltre l'estremo della candela di ingresso" },
      { label: "Tempo massimo in posizione", value: "45 min", hint: "uscita a mercato se il rientro non arriva" },
      { label: "Titoli max in portafoglio", value: "8 / 20", hint: "le estensioni più ampie dell'universo" },
    ],
    backtest: {
      net: 3120,
      sharpe: 1.21,
      winRate: 0.57,
      tradesPerSession: 26,
      costs: 148,
      profitFactor: 1.49,
      dailyPnl: [90, 140, -40, 180, 210, 60, -70, 160, 240, 120, 80, -30, 200, 150, 110, 230, 70, -50, 190, 260],
    },
  },
];

/** P&L realized per periodo — laboratorio, costi dedotti. Storico multi-giorno: non dipende dal prezzo live di oggi. */
const PNL: Record<Strategy["code"], { d: number; w: number; m: number; a: number }> = {
  "LAB A": { d: 980, w: 4120, m: 9640, a: 21480 },
  "LAB B": { d: 640, w: 2980, m: 7240, a: 16320 },
  "LAB C": { d: 820, w: 3260, m: 6980, a: 14760 },
};
const PNL_REAL = { d: 1240, w: 6360, m: 12290, a: 24870 };
const INCEPTION_DATE = "2026-03-03";

function pickOrbAndVwapSets(market: MarketRow[]): { orbSet: Set<string>; vwapSet: Set<string> } {
  // Selezione dei candidati: il numero di titoli tenuti è lo stesso stampato nei parametri.
  const byMove = [...market].sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
  const CAP_ORB = 6;
  const CAP_VWAP = 8;
  const orbSet = new Set(byMove.slice(0, CAP_ORB).map((x) => x.symbol));
  const vwapSet = new Set(
    byMove.filter((x) => Math.abs(x.changePct) >= 0.4).slice(0, CAP_VWAP).map((x) => x.symbol)
  );
  return { orbSet, vwapSet };
}

export interface BookCell {
  side: Side;
  qty: number;
  avg: number;
  last: number;
  unreal: number;
  real: number;
}

export interface BookRow {
  symbol: string;
  name: string;
  price: number;
  qty: number;
  cells: BookCell[];
}

/** Stato di ogni titolo in ogni portafoglio laboratorio, derivato in modo deterministico dal dataset di mercato dato. */
export function buildBook(market: MarketRow[]): BookRow[] {
  const { orbSet, vwapSet } = pickOrbAndVwapSets(market);
  return market.map((row, idx) => {
    const qty = Math.floor(CAPITAL / market.length / row.price);
    const cells: BookCell[] = STRATEGIES.map((_, i) => {
      const b = hash(i + "|" + row.symbol);
      const c = hash(row.symbol + "#" + i);
      let side: Side = "LONG";
      // ORB: solo le 6 rotture più ampie, nella direzione della rottura
      if (i === 0) side = !orbSet.has(row.symbol) ? "FLAT" : row.changePct > 0 ? "LONG" : "SHORT";
      // pairs trading: gambe accoppiate, esposizione netta nulla
      if (i === 1) side = idx % 2 === 0 ? "LONG" : "SHORT";
      // VWAP reversion: contro le 8 estensioni maggiori dal VWAP
      if (i === 2) side = !vwapSet.has(row.symbol) ? "FLAT" : row.changePct > 0 ? "SHORT" : "LONG";

      const movePct = (b - 0.44) * 2.4;
      const dir = side === "SHORT" ? -1 : 1;
      const avg = side === "FLAT" ? row.price : row.price / (1 + (dir * movePct) / 100);
      const unreal = side === "FLAT" ? 0 : Math.round(dir * qty * (row.price - avg));
      const hasClosed = side === "FLAT" ? c > 0.8 : i === 0 ? c > 0.66 : i === 1 ? c > 0.22 : c > 0.44;
      const real = hasClosed ? Math.round((c - 0.38) * 420) : 0;
      return { side, qty, avg, last: row.price, unreal, real };
    });
    return { symbol: row.symbol, name: row.name, price: row.price, qty, cells };
  });
}

/** Realized/unrealized aggregati per strategia, sommando tutte le righe del libro comune. */
export function buildStrategySums(book: BookRow[]): { unrealized: number; realized: number }[] {
  return STRATEGIES.map((_, i) =>
    book.reduce(
      (acc, row) => {
        acc.unrealized += row.cells[i].unreal;
        acc.realized += row.cells[i].real;
        return acc;
      },
      { unrealized: 0, realized: 0 }
    )
  );
}

/** Curva di equity intraday coerente col netto di ogni portafoglio (12 punti). */
export function buildEquityCurves(sums: { unrealized: number; realized: number }[]): number[][] {
  return sums.map((sum, i) => {
    const net = sum.unrealized + sum.realized;
    return Array.from({ length: 12 }, (_, k) => {
      const t = k / 11;
      return Math.round(net * t + (hash(i + "c" + k) - 0.5) * Math.abs(net) * 0.32 * (1 - Math.abs(t - 0.5)));
    });
  });
}

/** Classifica intraday (solo per il badge "MIGLIORE OGGI" sulle card lab). */
export function buildTodayRank(sums: { unrealized: number; realized: number }[]): number[] {
  const order = sums
    .map((sum, i) => ({ i, net: sum.unrealized + sum.realized - STRATEGIES[i].backtest.costs }))
    .sort((a, b) => b.net - a.net);
  const rankOf = new Array(STRATEGIES.length).fill(0);
  order.forEach((o, k) => (rankOf[o.i] = k));
  return rankOf;
}

/** Numero di posizioni con unrealized positivo su tutti i lab — banner regola EOD. */
export function buildPositionsToClose(book: BookRow[]): number {
  return book.reduce((n, row) => n + row.cells.filter((c) => c.unreal > 0).length, 0);
}

/** Dataset di fallback (demo), calcolato una volta dai prezzi statici in MARKET. */
export const BOOK: BookRow[] = buildBook(MARKET);
export const STRATEGY_SUMS = buildStrategySums(BOOK);
export const EQUITY_CURVES: number[][] = buildEquityCurves(STRATEGY_SUMS);
export const TODAY_RANK: number[] = buildTodayRank(STRATEGY_SUMS);
export const POSITIONS_TO_CLOSE: number = buildPositionsToClose(BOOK);

/** Classifica del debriefing: basata sul netto delle 20 sedute di backtest (storico, non dipende dal prezzo live). */
export const BACKTEST_ORDER = STRATEGIES.map((s, i) => ({ i, net: s.backtest.net })).sort(
  (a, b) => b.net - a.net
);
export const BEST_STRATEGY_INDEX = BACKTEST_ORDER[0].i;

function toPosition(row: BookRow, cellIndex: number): Position {
  const c = row.cells[cellIndex];
  return {
    symbol: row.symbol,
    side: c.side,
    qty: c.qty,
    avgPrice: c.avg,
    lastPrice: c.last,
    unrealized: c.unreal,
    realizedToday: c.real,
  };
}

export function labPortfolio(
  strategyIndex: number,
  book: BookRow[] = BOOK,
  sums: { unrealized: number; realized: number }[] = STRATEGY_SUMS,
  curves: number[][] = EQUITY_CURVES
): Portfolio {
  const s = STRATEGIES[strategyIndex];
  const sum = sums[strategyIndex];
  return {
    id: s.code.toLowerCase().replace(" ", "-"),
    kind: "lab",
    strategyId: s.id,
    capital: CAPITAL,
    positions: book.filter((r) => r.cells[strategyIndex].side !== "FLAT").map((r) =>
      toPosition(r, strategyIndex)
    ),
    realizedToday: sum.realized,
    unrealized: sum.unrealized,
    trades: s.backtest.tradesPerSession,
    winRate: s.backtest.winRate,
    sharpe: s.backtest.sharpe,
    costs: s.backtest.costs,
    equityIntraday: curves[strategyIndex],
  };
}

export const LAB_PORTFOLIOS: Portfolio[] = STRATEGIES.map((_, i) => labPortfolio(i));

export const REAL_PORTFOLIO: Portfolio = {
  ...labPortfolio(BEST_STRATEGY_INDEX),
  id: "real",
  kind: "real",
  deviationFromLabPct: -0.3,
};

export const PERIOD_PNL: PeriodPnl[] = [
  ...STRATEGIES.map((s) => ({
    portfolioId: s.code.toLowerCase().replace(" ", "-"),
    lastSession: PNL[s.code].d,
    previousWeek: PNL[s.code].w,
    previousMonth: PNL[s.code].m,
    sinceInception: PNL[s.code].a,
    inceptionDate: INCEPTION_DATE,
  })),
  {
    portfolioId: "real",
    lastSession: PNL_REAL.d,
    previousWeek: PNL_REAL.w,
    previousMonth: PNL_REAL.m,
    sinceInception: PNL_REAL.a,
    inceptionDate: INCEPTION_DATE,
  },
];

export function periodPnlFor(portfolioId: string): PeriodPnl {
  const found = PERIOD_PNL.find((p) => p.portfolioId === portfolioId);
  if (!found) throw new Error(`Nessun P&L per periodo per il portafoglio ${portfolioId}`);
  return found;
}

export const EXECUTIONS: Execution[] = [
  { ts: "17:42", symbol: "NVDA", action: "SELL", qty: 40, price: 129.6, realized: 312 },
  { ts: "17:20", symbol: "AAPL", action: "BUY", qty: 21, price: 234.34, realized: null },
  { ts: "16:58", symbol: "XOM", action: "SELL", qty: 43, price: 116.3, realized: -84 },
  { ts: "16:31", symbol: "UNH", action: "BUY", qty: 9, price: 512.8, realized: null },
  { ts: "16:04", symbol: "CAT", action: "SELL", qty: 13, price: 368.2, realized: 130 },
  { ts: "15:47", symbol: "TXN", action: "BUY", qty: 25, price: 197.4, realized: null },
  { ts: "15:33", symbol: "MSFT", action: "BUY", qty: 11, price: 418.75, realized: null },
];

const HIST_STRATS: number[] = [0, 1, 2, 1, 0, 1, 2, 1, 0, 1];
const HIST_NET: number[] = [1240, 2180, 640, -820, 1460, 3120, 580, 1940, -310, 2260];

export const SESSIONS: Session[] = HIST_STRATS.map((si, k) => ({
  date: String(11 - k).padStart(2, "0") + " set",
  strategyId: STRATEGIES[si].id,
  net: HIST_NET[k],
  deviationPct: (hash("d" + k) > 0.5 ? -1 : 1) * hash("e" + k) * 0.6,
  trades: STRATEGIES[si].backtest.tradesPerSession,
  costs: STRATEGIES[si].backtest.costs,
}));

export interface StrategyHistoryStat {
  strategyId: StrategyId;
  name: string;
  netOver10Sessions: number;
  timesPicked: number;
  sharpe: number;
  costs: number;
}

export const STRATEGY_HISTORY_STATS: StrategyHistoryStat[] = STRATEGIES.map((s, i) => {
  const picked = HIST_STRATS.filter((x) => x === i).length;
  const pnl = HIST_STRATS.reduce((acc, x, k) => (x === i ? acc + HIST_NET[k] : acc), 0);
  return {
    strategyId: s.id,
    name: s.name,
    netOver10Sessions: pnl,
    timesPicked: picked,
    sharpe: s.backtest.sharpe,
    costs: s.backtest.costs,
  };
});

export const DEBRIEF: Debrief = {
  date: "2026-09-12",
  ranking: BACKTEST_ORDER.map((o, k) => ({
    strategyId: STRATEGIES[o.i].id,
    score: Math.round((16.4 - k * 2.5) * 10) / 10,
    basis: "backtest_20_sessions",
  })),
  proposed: STRATEGIES[BEST_STRATEGY_INDEX].id,
  confidence: 78,
  vix: { value: 14.8, regime: "calmo" },
  checklist: [
    { label: "Dati di mercato Alpaca", value: "OK", status: "ok" },
    { label: "Allineamento dei 3 portafogli lab", value: "identici", status: "ok" },
    { label: "Posizioni residue dalla seduta precedente", value: "0", status: "ok" },
    { label: "Eventi macro in giornata", value: "CPI 14:30", status: "warning" },
  ],
  confirmedAt: null,
};

export const SESSION_RULES: SessionRules = {
  closeProfitableAtEod: true,
  eodOrderTime: "21:55",
  debriefTime: "22:15",
  autoConfirm: false,
  universe: MARKET.map((m) => m.symbol),
  capitalPerPortfolio: CAPITAL,
  weighting: "equal",
};

export const BROKERS: BrokerStatus[] = [
  { id: "alpaca", displayName: "Alpaca", connected: true, environment: "live", maskedKey: "PK••••••••••7F2C · conto live" },
  { id: "ibkr", displayName: "Interactive Brokers", connected: false, environment: "paper", maskedKey: "nessuna chiave configurata" },
  { id: "binance", displayName: "Binance", connected: false, environment: "paper", maskedKey: "nessuna chiave configurata" },
];

export function strategyByIndex(i: number): Strategy {
  return STRATEGIES[i];
}

// --- Dati di mercato live: stesso motore di simulazione, prezzi reali quando disponibili ---

export interface LiveMarketData {
  market: MarketRow[];
  book: BookRow[];
  strategySums: { unrealized: number; realized: number }[];
  equityCurves: number[][];
  todayRank: number[];
  positionsToClose: number;
}

/** Dataset "live" di fallback: identico al dataset demo finché non arrivano quotazioni reali. */
export const FALLBACK_LIVE_MARKET_DATA: LiveMarketData = {
  market: MARKET,
  book: BOOK,
  strategySums: STRATEGY_SUMS,
  equityCurves: EQUITY_CURVES,
  todayRank: TODAY_RANK,
  positionsToClose: POSITIONS_TO_CLOSE,
};

/**
 * Sovrascrive prezzo/variazione con quotazioni reali (per i simboli disponibili) e
 * ricalcola libro/aggregati con lo stesso motore deterministico usato per il fallback.
 * La logica di simulazione delle 3 strategie resta invariata: cambia solo l'input.
 */
export function buildLiveMarketData(liveQuotes: Record<string, { price: number; changePct: number }>): LiveMarketData {
  const market: MarketRow[] = MARKET.map((row) => {
    const live = liveQuotes[row.symbol];
    return live ? { ...row, price: live.price, changePct: live.changePct } : row;
  });
  const book = buildBook(market);
  const strategySums = buildStrategySums(book);
  const equityCurves = buildEquityCurves(strategySums);
  const todayRank = buildTodayRank(strategySums);
  const positionsToClose = buildPositionsToClose(book);
  return { market, book, strategySums, equityCurves, todayRank, positionsToClose };
}

// --- Posizioni reali dei laboratori (lab_positions), quando disponibili ---

export interface RealLabPosition {
  symbol: string;
  side: Side;
  qty: number;
  entryPrice: number;
}

export interface RealLabStrategyData {
  openPositions: RealLabPosition[];
  realizedToday: number;
}

/** Una voce per strategia con dati reali (id = "orb" | "pairs" | "vwap_reversion"); assente = ancora simulata. */
export type RealLabOverrides = Partial<Record<StrategyId, RealLabStrategyData>>;

/**
 * Sostituisce, per le sole strategie con dati reali, le celle simulate del libro con le
 * posizioni vere da `lab_positions` (unrealized ricalcolato sul prezzo live corrente).
 * Le strategie senza dati reali restano invariate (simulazione). Il "realized" per
 * simbolo non è tracciato lato server per le strategie reali (solo l'aggregato lo è),
 * quindi qui resta a zero/"—" — l'aggregato corretto va preso da RealLabStrategyData.realizedToday.
 */
export function applyRealLabData(book: BookRow[], realData: RealLabOverrides): BookRow[] {
  if (Object.keys(realData).length === 0) return book;
  return book.map((row) => {
    const cells = row.cells.map((cell, idx) => {
      const real = realData[STRATEGIES[idx].id];
      if (!real) return cell;
      const pos = real.openPositions.find((p) => p.symbol === row.symbol);
      if (!pos) return { side: "FLAT" as Side, qty: cell.qty, avg: row.price, last: row.price, unreal: 0, real: 0 };
      const dir = pos.side === "SHORT" ? -1 : 1;
      const unreal = Math.round(dir * pos.qty * (row.price - pos.entryPrice));
      return { side: pos.side, qty: pos.qty, avg: pos.entryPrice, last: row.price, unreal, real: 0 };
    });
    return { ...row, cells };
  });
}

/** Ricalcola gli aggregati per strategia dal libro (eventualmente già corretto da applyRealLabData). */
export function applyRealStrategySums(
  book: BookRow[],
  realData: RealLabOverrides
): { unrealized: number; realized: number }[] {
  return STRATEGIES.map((s, i) => {
    const real = realData[s.id];
    const unrealized = book.reduce((acc, row) => acc + row.cells[i].unreal, 0);
    if (!real) return buildStrategySums(book)[i];
    return { unrealized, realized: real.realizedToday };
  });
}

/** Combina un LiveMarketData (prezzi live) con le posizioni reali dei lab, dove disponibili. */
export function mergeRealLabData(data: LiveMarketData, realData: RealLabOverrides): LiveMarketData {
  if (Object.keys(realData).length === 0) return data;
  const book = applyRealLabData(data.book, realData);
  const strategySums = applyRealStrategySums(book, realData);
  const equityCurves = buildEquityCurves(strategySums);
  const todayRank = buildTodayRank(strategySums);
  const positionsToClose = buildPositionsToClose(book);
  return { ...data, book, strategySums, equityCurves, todayRank, positionsToClose };
}

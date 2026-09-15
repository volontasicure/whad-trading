export type Side = "LONG" | "SHORT" | "FLAT";

export interface Instrument {
  symbol: string;
  name: string;
}

export interface Quote {
  symbol: string;
  last: number;
  changePct: number;
  ts: string;
}

export interface Position {
  symbol: string;
  side: Side;
  qty: number;
  avgPrice: number;
  lastPrice: number;
  /** qty × (last − avg), segno invertito sugli short */
  unrealized: number;
  realizedToday: number;
}

export interface StrategyParam {
  label: string;
  value: string;
  hint: string;
}

export type StrategyId = "orb" | "pairs" | "vwap_reversion";

export interface Strategy {
  id: StrategyId;
  code: "LAB A" | "LAB B" | "LAB C";
  name: string;
  shortName: string;
  /** una frase: come opera */
  logic: string;
  /** una frase: punti di forza/debolezza, indipendente dal ranking */
  note: string;
  params: StrategyParam[];
  /** deve coincidere col valore mostrato nei params */
  maxPositions: number;
  backtest: {
    net: number;
    sharpe: number;
    winRate: number;
    tradesPerSession: number;
    costs: number;
    profitFactor: number;
    /** 20 valori */
    dailyPnl: number[];
  };
}

export interface Portfolio {
  id: string;
  kind: "lab" | "real";
  strategyId: StrategyId;
  /** identico su tutti i lab */
  capital: number;
  positions: Position[];
  realizedToday: number;
  unrealized: number;
  trades: number;
  winRate: number;
  sharpe: number;
  costs: number;
  /** per la sparkline */
  equityIntraday: number[];
  /** solo kind = "real" */
  deviationFromLabPct?: number;
}

export interface PeriodPnl {
  /** realized, costi dedotti */
  portfolioId: string;
  lastSession: number;
  previousWeek: number;
  previousMonth: number;
  sinceInception: number;
  inceptionDate: string;
}

export interface Execution {
  ts: string;
  symbol: string;
  action: "BUY" | "SELL";
  qty: number;
  price: number;
  realized: number | null;
}

export interface Session {
  date: string;
  strategyId: StrategyId;
  net: number;
  /** lab vs reale */
  deviationPct: number;
  trades: number;
  costs: number;
}

export interface Debrief {
  date: string;
  ranking: { strategyId: StrategyId; score: number; basis: "backtest_20_sessions" }[];
  proposed: StrategyId;
  confidence: number;
  vix: { value: number; regime: "calmo" | "normale" | "teso" };
  checklist: { label: string; value: string; status: "ok" | "warning" | "error" }[];
  confirmedAt: string | null;
}

export interface SessionRules {
  closeProfitableAtEod: boolean;
  eodOrderTime: string;
  debriefTime: string;
  autoConfirm: boolean;
  /** 40 simboli */
  universe: string[];
  capitalPerPortfolio: number;
  weighting: "equal";
}

export interface BrokerStatus {
  id: string;
  displayName: string;
  connected: boolean;
  environment: "paper" | "live" | null;
  maskedKey: string;
}

export interface OrderRequest {
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  type: "market" | "limit";
  limitPrice?: number;
}

/**
 * Un'unica interfaccia, una implementazione per broker (Alpaca prima, poi IBKR/Binance).
 * La UI non deve mai importare un SDK di broker. Vedi API.md per il contratto originale.
 */
export interface BrokerAdapter {
  id: string;
  displayName: string;
  status(): Promise<BrokerStatus>;
  getPositions(portfolioId: string): Promise<Position[]>;
  getRealizedPnl(portfolioId: string, period: "day" | "week" | "month" | "inception"): Promise<number>;
  getExecutions(portfolioId: string, since: string): Promise<Execution[]>;
  submitOrder(o: OrderRequest): Promise<{ orderId: string }>;
  closePosition(symbol: string): Promise<{ orderId: string }>;
  /** Ritorna una funzione di unsubscribe. */
  streamQuotes(symbols: string[], cb: (q: Quote) => void): () => void;
  marketClock(): Promise<{ isOpen: boolean; nextClose: string; nextOpen: string }>;
}

/** Stato del LAB D (trend ETF) dal backend — specchio di TrendSnapshot in server/trendRunner.ts. */
export interface TrendRowView {
  symbol: string;
  qty: number;
  entryPrice: number | null;
  last: number | null;
  value: number;
  weightPct: number;
  unrealized: number;
  signal: { close: number; sma: number; distancePct: number; above: boolean; volPct: number } | null;
  targetWeightPct: number;
}

export interface TrendSnapshotView {
  capital: number;
  equity: number;
  pnl: number;
  pnlPct: number;
  realizedNet: number;
  unrealized: number;
  cashPct: number;
  startedAt: string | null;
  lastRebalance: { date: string; month: string; closes: number; opens: number; gross: number; portfolioVol: number } | null;
  nextRebalanceMonth: string;
  rows: TrendRowView[];
  pricesAvailable: boolean;
}

export async function fetchTrend(): Promise<TrendSnapshotView> {
  const res = await fetch("/api/lab/trend");
  if (!res.ok) throw new Error(`trend -> ${res.status}`);
  return (await res.json()) as TrendSnapshotView;
}

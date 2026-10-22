/** Stato dei lab ETF (LAB D trend, LAB E rotazione) e del portafoglio proposto dal backend — specchio di EtfLabsSnapshot in server/trendRunner.ts. */
export interface TrendRowView {
  symbol: string;
  qty: number;
  entryPrice: number | null;
  last: number | null;
  value: number;
  weightPct: number;
  unrealized: number;
  signal: { close: number; sma: number; distancePct: number; above: boolean; volPct: number } | null;
  score: { scorePct: number; rank: number; selected: boolean } | null;
  targetWeightPct: number;
}

export interface TrendSnapshotView {
  strategyId: string;
  capital: number;
  equity: number;
  pnl: number;
  pnlPct: number;
  realizedNet: number;
  unrealized: number;
  billsPct: number;
  cashPct: number;
  startedAt: string | null;
  lastRebalance: { date: string; month: string; closes: number; opens: number; gross: number; portfolioVol: number; version: string | null } | null;
  nextRebalanceMonth: string;
  cashScorePct: number | null;
  rows: TrendRowView[];
}

export interface CoreSnapshotView {
  startedAt: string | null;
  startDate: string | null;
  capital: number;
  weights: Record<string, number>;
  parts: { strategyId: string; pnl: number; weight: number; contribution: number }[];
  pnl: number;
  pnlPct: number;
  equity: number;
  grossPct: number;
}

export interface EtfLabsSnapshotView {
  pricesAvailable: boolean;
  params: { version: string; trend: { smaDays: number; targetVol: number }; rotation: { months: number[]; topK: number } };
  trend: TrendSnapshotView;
  rotation: TrendSnapshotView;
  core: CoreSnapshotView;
}

export async function fetchTrend(): Promise<EtfLabsSnapshotView> {
  const res = await fetch("/api/lab/trend");
  if (!res.ok) throw new Error(`trend -> ${res.status}`);
  return (await res.json()) as EtfLabsSnapshotView;
}

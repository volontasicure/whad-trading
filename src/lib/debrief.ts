import type { StrategyId } from "../types";

export interface RealRankingEntry {
  strategyId: StrategyId;
  net: number;
  trades: number;
}

export interface RealSession {
  tradingDate: string;
  strategyId: StrategyId;
  net: number;
  deviationPct: number;
  trades: number;
  costs: number;
  confirmedAt: string | null;
}

export interface RealDebrief {
  ranking: RealRankingEntry[];
  /** Quante sedute reali entrano nel calcolo (<20 finché non se ne sono accumulate 20; 0 = nessuno storico ancora, giorno 1). */
  sessionsUsed: number;
  /** null finché sessionsUsed è 0 — non c'è ancora una proposta sensata da fare. */
  proposedStrategyId: StrategyId | null;
  confirmedAt: string | null;
  sessions: RealSession[];
}

/** Legge classifica/proposta/storico reali dal backend; lancia se non disponibili. */
export async function fetchDebrief(): Promise<RealDebrief> {
  const res = await fetch("/api/debrief");
  if (!res.ok) {
    throw new Error(`debrief -> ${res.status}`);
  }
  return (await res.json()) as RealDebrief;
}

/** Registra la conferma di oggi ("Conferma e attiva"); lancia se la scrittura fallisce. */
export async function confirmDebrief(): Promise<{ confirmedAt: string | null }> {
  const res = await fetch("/api/debrief", { method: "POST" });
  if (!res.ok) {
    throw new Error(`debrief confirm -> ${res.status}`);
  }
  return (await res.json()) as { confirmedAt: string | null };
}

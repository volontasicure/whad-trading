import type { StrategyId } from "../types";

export interface RealRankingEntry {
  strategyId: StrategyId;
  net: number;
  trades: number;
}

export interface RealSession {
  tradingDate: string;
  /** Dal 25/9/2026 può essere composito ("pairs+vwap_reversion", più strategie ammesse lo stesso giorno) — mai un solo StrategyId garantito. */
  strategyId: string;
  net: number;
  deviationPct: number;
  trades: number;
  costs: number;
  confirmedAt: string | null;
}

/** Una riga per strategia: se è ammessa al capitale reale oggi, con che peso, e perché (o perché no). Dal 25/9/2026 (server/strategyAllocation.ts) sostituisce l'unica proposedStrategyId. */
export interface AllocationEntry {
  strategyId: StrategyId;
  eligible: boolean;
  reason: string;
  sessionsAvailable: number;
  drawdownPct: number;
  /** 0 se non ammessa; altrimenti equal-weight tra le ammesse (sempre <= 1, la somma su tutte fa 1 se almeno una è ammessa). */
  weight: number;
}

export interface RealDebrief {
  ranking: RealRankingEntry[];
  /** Quante sedute reali entrano nel calcolo (<20 finché non se ne sono accumulate 20; 0 = nessuno storico ancora, giorno 1). */
  sessionsUsed: number;
  allocation: AllocationEntry[];
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

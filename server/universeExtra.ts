/**
 * 40 titoli candidati per un universo allargato (da 40 a 80) — SOLO per esperimenti di backtest
 * (scripts/backtest.ts, EXP_EXTRA_UNIVERSE=1): non fanno parte dell'universo di produzione
 * (server/universe.ts) e nessun codice di produzione li importa. Bilanciati per settore (5 per
 * settore) più un settore nuovo, "utilities", classico terreno del pairs trading (titoli a bassa
 * volatilità e fortemente legati). Il pairs trading ha come collo di bottiglia la rarità dei
 * segnali, non la capacità: più titoli per settore = più coppie candidate.
 */
export const EXTRA_UNIVERSE_SECTORS: Record<string, string> = {
  // tech
  ADBE: "tech",
  AMD: "tech",
  INTC: "tech",
  CSCO: "tech",
  QCOM: "tech",
  // financials
  C: "financials",
  MS: "financials",
  AXP: "financials",
  SCHW: "financials",
  BLK: "financials",
  // energy
  EOG: "energy",
  PSX: "energy",
  MPC: "energy",
  OXY: "energy",
  VLO: "energy",
  // staples
  MDLZ: "staples",
  CL: "staples",
  KMB: "staples",
  GIS: "staples",
  PM: "staples",
  // healthcare
  PFE: "healthcare",
  BMY: "healthcare",
  AMGN: "healthcare",
  GILD: "healthcare",
  MDT: "healthcare",
  // industrials
  UPS: "industrials",
  RTX: "industrials",
  DE: "industrials",
  LMT: "industrials",
  MMM: "industrials",
  // consumer discretionary
  LOW: "consumer_disc",
  TJX: "consumer_disc",
  TGT: "consumer_disc",
  F: "consumer_disc",
  GM: "consumer_disc",
  // utilities (settore nuovo)
  DUK: "utilities",
  SO: "utilities",
  NEE: "utilities",
  D: "utilities",
  AEP: "utilities",
};

export const EXTRA_UNIVERSE_SYMBOLS: string[] = Object.keys(EXTRA_UNIVERSE_SECTORS);

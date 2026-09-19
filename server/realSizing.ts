// Sizing "libero" per il conto reale: a differenza dei lab (equal-weight, CAPITAL/MAX_POSITIONS,
// per confrontabilità tra strategie), qui l'obiettivo è massimizzare il realized — la size di
// ogni posizione è proporzionale alla convinzione del segnale che l'ha generata (forza della
// rottura per ORB, distanza dal VWAP per VWAP, |z-score| per pairs), non uguale per tutti.
//
// Il conto reale trada una sola strategia alla volta (quella scelta al debriefing), quindi non
// serve una scala comparabile tra strategie diverse — solo un ordinamento relativo tra i
// candidati del giorno per la stessa strategia.

/** Moltiplicatori min/max rispetto alla baseline equal-weight (capital/maxPositions): un segnale
 *  estremo non deve prosciugare il budget, uno marginale non deve ricevere una size simbolica. */
export const FLOOR_MULT = 0.5;
/** Portato da 2,0 a 1,0 il 19/9/2026: con pochi candidati il peso per convinzione satura sempre il tetto, quindi il reale operava a 2x la size del lab su ogni trade (rapporto 1,92-2,00 su tutte le 20 posizioni ORB del 16-18/9) — di fatto una leva doppia, senza un vantaggio misurato che la giustificasse. */
export const CAP_MULT = 1.0;

export interface SizingCandidate {
  symbol: string;
  price: number;
  /** Punteggio di convinzione del segnale, sempre >= 0 (usare il valore assoluto a monte per
   *  metriche con segno come z-score o distancePct). */
  conviction: number;
}

/**
 * Alloca il capitale disponibile tra i candidati, proporzionalmente alla convinzione
 * normalizzata, clampata a [FLOOR_MULT, CAP_MULT] × baseline. Itera per convinzione
 * decrescente scalando sul capitale residuo: il totale speso non supera mai totalCapital,
 * qualunque sia l'arrotondamento — invariante di sicurezza su capitale reale.
 */
export function sizeByConviction(
  candidates: SizingCandidate[],
  totalCapital: number,
  maxPositions: number
): Record<string, number> {
  const out: Record<string, number> = {};
  if (candidates.length === 0 || totalCapital <= 0 || maxPositions <= 0) return out;

  const baseline = totalCapital / maxPositions;
  const floorDollars = FLOOR_MULT * baseline;
  const capDollars = CAP_MULT * baseline;

  const totalConviction = candidates.reduce((sum, c) => sum + Math.max(0, c.conviction), 0);
  const sorted = [...candidates].sort((a, b) => b.conviction - a.conviction);

  let remainingCapital = totalCapital;
  for (const c of sorted) {
    if (remainingCapital < floorDollars) break;

    const weight = totalConviction > 0 ? Math.max(0, c.conviction) / totalConviction : 1 / candidates.length;
    const target = Math.min(capDollars, Math.max(floorDollars, weight * totalCapital));
    const dollars = Math.min(target, remainingCapital);

    const qty = Math.floor(dollars / c.price);
    if (qty < 1) continue;

    const spent = qty * c.price;
    out[c.symbol] = qty;
    remainingCapital -= spent;
  }

  return out;
}

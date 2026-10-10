// Coordinamento tra strategie sul conto reale (logica pura, nessun I/O).
//
// Sul conto reale esiste UN solo Alpaca, quindi UNA posizione netta per titolo, condivisa da
// ORB/VWAP/pairs — mentre real_positions tiene una riga per strategia, come se ognuna avesse un
// libro proprio (corretto per i lab, che sono davvero tre conti simulati separati). Trovato
// l'8-10/10/2026: il VWAP ha comprato AVGO (3 × 16 azioni) mentre il pairs TXN/AVGO teneva già
// AVGO long 6; l'EOD ha poi venduto 22 azioni e marcato chiuse tutte le righe del simbolo,
// compresa la gamba del pairs — lasciando TXN short 8 aperta da sola, mai più gestita
// (decideExits ignora le gambe orfane). Un titolo = una strategia alla volta, e una gamba
// rimasta sola va chiusa.

export interface RowLite {
  id: number;
  symbol: string;
  pair_key: string | null;
}

/**
 * Id delle righe di coppia rimaste con UNA sola gamba aperta (l'altra chiusa fuori strategia o
 * mai aperta, es. secondo ordine fallito): esposizione non coperta che la strategia non
 * accetta di tenere ("mai una gamba orfana"), da chiudere.
 */
export function findOrphanLegIds(rows: { id: number; pair_key: string | null }[]): Set<number> {
  const byKey = new Map<string, number[]>();
  for (const r of rows) {
    if (!r.pair_key) continue;
    if (!byKey.has(r.pair_key)) byKey.set(r.pair_key, []);
    byKey.get(r.pair_key)!.push(r.id);
  }
  const orphans = new Set<number>();
  for (const ids of byKey.values()) if (ids.length < 2) for (const id of ids) orphans.add(id);
  return orphans;
}

/**
 * Simboli con almeno una riga reale aperta, di QUALUNQUE strategia (gambe pairs incluse), meno
 * le righe già chiuse in questo tick (closedIds) — nessuna strategia deve aprire un ingresso su
 * un titolo che un'altra tiene già.
 */
export function occupiedSymbols(rows: RowLite[], closedIds: Set<number>): Set<string> {
  const out = new Set<string>();
  for (const r of rows) if (!closedIds.has(r.id)) out.add(r.symbol);
  return out;
}

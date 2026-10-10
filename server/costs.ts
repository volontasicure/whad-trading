// Costi di esecuzione dei portafogli laboratorio.
//
// I lab sono simulati e fillano al prezzo della barra, senza spread né slippage: fino al
// 10/10/2026 `realized_pnl` era LORDO e `sessions.costs` valeva sempre 0. Il conto reale invece
// paga lo slippage sui fill veri — misurato il 10/10 su 47 trade VWAP abbinati lab↔reale:
// 0,022% in ingresso e 0,026% in uscita, ≈0,023% per lato. Un lab lordo premia le strategie ad
// alto turnover (il VWAP a 1,2% muoveva ~29M$ per 100 sedute: lordo +3.440, netto −3.984) e
// falsa sia il confronto reale↔lab sia i gate di ammissione al capitale reale.
//
// I costi si DEDUCONO IN LETTURA, non alla scrittura: il P&L lordo in lab_positions resta
// invariato e lo storico è retroattivamente coerente (nessuna serie mista lordo/netto); per
// cambiare l'ipotesi di costo basta cambiare questa costante. Vale per le righe CHIUSE: un
// giro completo costa pct × qty × (prezzo di ingresso + prezzo di uscita). Le righe di
// real_positions NON passano di qui: i loro fill includono già lo slippage reale.

export const LAB_COST_PCT_PER_SIDE = 0.00023;

/** P&L netto di costi di una riga chiusa di lab_positions, come frazione SQL (colonne non qualificate). */
export const LAB_NET_PNL_SQL = `(realized_pnl - ${LAB_COST_PCT_PER_SIDE} * qty * (entry_price + exit_price))`;

// Logica di una strategia sperimentale "overnight drift" — chiusura di oggi → apertura di
// domani, un solo segnale al giorno per titolo, mai un ingresso intraday. Nasce dalla lettura
// critica dello storico esistente il 29/9/2026: le tre strategie in produzione sono tutte
// intraday (segnale ricalcolato ogni 5 minuti), e la più selettiva delle tre (pairs, un
// ingresso ogni tanto) è anche l'unica costantemente positiva, mentre le due più frequenti
// (ORB, VWAP) sono le più deboli — un pattern che punta verso "meno segnali, più selettivi",
// non verso un'altra variante di momentum intraday (già provata due volte, SRATS e breakdown
// ladder short, entrambe scartate per overfitting, vedi CLAUDE.md punto 10).
//
// Ipotesi da verificare via backtest, non assunta: un titolo con un rendimento intraday
// estremo oggi (rispetto agli altri 39 dell'universo) o CONTINUA quel movimento nell'overnight
// ("continuation") o lo INVERTE all'apertura di domani ("reversal") — le due ipotesi sono
// opposte, il segno lo decide il backtest (scripts/backtest-overnight-drift.ts), non questo
// modulo.
//
// Rischio dichiarato, diverso dalle altre tre: a mercato chiuso non esiste un prezzo su cui
// mettere uno stop. Il rischio qui è contenuto solo dalla diversificazione tra più posizioni
// (equal-weight, mai concentrato su un solo titolo), non da un livello di uscita.
//
// Modulo isolato: nessun impatto sul sistema in produzione finché non è validato con un
// backtest su dati storici reali. Non wired a tick.ts/db/schema.
//
// ESITO (29/9/2026): TESTATA E SCARTATA. Il primo giro (TOP_K=5) sembrava positivo su
// entrambe le finestre e batteva un semplice buy&hold — ma due controlli l'hanno smontato:
// (1) sensibilità a TOP_K: solo 2 valori su 6 testati (5 e 15, non vicini tra loro) restavano
// positivi su entrambe le finestre, gli altri (2,3,8,10) misti — profilo tipico di un
// risultato che ha funzionato per caso a un valore specifico, non un effetto robusto.
// (2) concentrazione: un solo trade (CRM long, 26/8) spiegava quasi metà del P&L totale; i
// primi 3 titoli (CRM/ORCL/META) il 143% del totale (gli altri 37 titoli, insieme, in perdita
// netta); i 5 migliori trade singoli il 117%. Non un effetto distribuito sull'universo — poche
// mosse isolate (probabilmente notizie/utili societari) che hanno reso il totale positivo per
// caso. Terza strategia da zero scartata dopo SRATS e "breakdown ladder short" (CLAUDE.md
// punto 10) — stesso pattern, promettente al primo sguardo, smontata al secondo controllo.
// Codice tenuto solo come memoria di un'idea già testata, non riprovarla senza nuove prove.

export const STRATEGY_ID = "overnight_drift";
export const CAPITAL = 100_000;
/** Titoli long + titoli short per lato (TOP_K long, TOP_K short => 2×TOP_K posizioni totali). */
export const TOP_K = 5;

export type Side = "LONG" | "SHORT";
export type Mode = "continuation" | "reversal";

export interface DailyOpenClose {
  symbol: string;
  open: number;
  close: number;
}

export interface OvernightEntry {
  symbol: string;
  side: Side;
  qty: number;
  entryPrice: number;
  /** Rendimento intraday di oggi (close/open - 1) che ha generato il segnale, per riferimento. */
  todayReturnPct: number;
}

/**
 * Ordina i titoli per rendimento intraday di oggi (close/open - 1) e sceglie i TOP_K più
 * forti e i TOP_K più deboli come candidati. Il lato (LONG/SHORT) dipende da `mode`:
 * "continuation" scommette che il movimento di oggi prosegue nell'overnight (long i più
 * forti, short i più deboli); "reversal" scommette il contrario. Richiede almeno 2×TOP_K
 * titoli con dati validi (open > 0), altrimenti restituisce meno posizioni, mai candidati
 * inventati.
 */
export function decideOvernightEntries(bars: DailyOpenClose[], mode: Mode, capital: number = CAPITAL, topK: number = TOP_K): OvernightEntry[] {
  const withReturn = bars
    .filter((b) => b.open > 0 && b.close > 0)
    .map((b) => ({ ...b, ret: b.close / b.open - 1 }))
    .sort((a, b) => b.ret - a.ret);

  if (withReturn.length === 0) return [];

  const strongest = withReturn.slice(0, topK);
  const weakest = withReturn.slice(-topK).reverse();

  const strongSide: Side = mode === "continuation" ? "LONG" : "SHORT";
  const weakSide: Side = mode === "continuation" ? "SHORT" : "LONG";

  const candidates: { symbol: string; side: Side; price: number; ret: number }[] = [
    ...strongest.map((b) => ({ symbol: b.symbol, side: strongSide, price: b.close, ret: b.ret })),
    ...weakest.map((b) => ({ symbol: b.symbol, side: weakSide, price: b.close, ret: b.ret })),
  ];

  // Un titolo non può comparire sia tra i più forti sia tra i più deboli (possibile solo se
  // l'universo ha meno di 2×topK titoli validi quel giorno) — se succede, lo si scarta da
  // entrambi i lati piuttosto che aprire due posizioni opposte sullo stesso simbolo.
  const seen = new Map<string, number>();
  for (const c of candidates) seen.set(c.symbol, (seen.get(c.symbol) ?? 0) + 1);
  const clean = candidates.filter((c) => seen.get(c.symbol) === 1);
  if (clean.length === 0) return [];

  const perPosition = capital / clean.length;
  return clean.map((c) => ({
    symbol: c.symbol,
    side: c.side,
    qty: Math.max(1, Math.floor(perPosition / c.price)),
    entryPrice: c.price,
    todayReturnPct: c.ret * 100,
  }));
}

/** P&L di una posizione overnight: entrata alla chiusura di oggi, uscita all'apertura di domani. */
export function overnightPnl(entry: OvernightEntry, nextOpen: number): number {
  const dir = entry.side === "LONG" ? 1 : -1;
  return Math.round(entry.qty * (nextOpen - entry.entryPrice) * dir);
}

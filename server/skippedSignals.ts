// Registro dei segnali che una strategia ha visto e il conto reale NON ha eseguito, col motivo.
//
// Perché esiste (13/10/2026): ogni scostamento reale↔lab spiegato finora (TXN orfana, doppia
// chiusura di BA, VWAP che collide con una gamba pairs, PEP/PG aperta nel lab ma non nel reale)
// è stato ricostruito a mano dopo giorni. Il motivo per cui il reale NON ha fatto qualcosa non
// finiva da nessuna parte: tick_log dice solo "N aperte". Qui si salva, deduplicato per giorno.
//
// Una riga per (giorno, strategia, soggetto, motivo): un segnale che resta bloccato per ore non
// produce 78 righe ma una sola con `ticks` crescente e first_seen/last_seen. Best-effort: un errore
// di scrittura non deve mai toccare l'esecuzione (il chiamante ha un try/catch).

import { db } from "./db.js";

export type SkipReason =
  /** Il titolo è già tenuto da un'altra strategia sul conto (una sola posizione netta per simbolo). */
  | "occupied_symbol"
  /** Gamba short su un titolo non shortabile / hard-to-borrow su Alpaca. */
  | "not_shortable"
  /** Coppia uscita in stop oggi: non rientra più nella stessa giornata. */
  | "cooldown_stop"
  /** Segnale valido ma tutti gli slot della strategia sono occupati. */
  | "no_free_slots"
  /** Il sizing per convinzione non ha assegnato nulla (budget troppo piccolo per il titolo). */
  | "sizing_zero"
  /** Limite di perdita giornaliero raggiunto: nessun nuovo ingresso, per nessuna strategia. */
  | "daily_loss_halt";

export interface SkipRecord {
  strategyId: string;
  /** Simbolo, chiave di coppia, oppure "*" per un blocco che vale per l'intera strategia. */
  subject: string;
  reason: SkipReason;
  detail?: string;
  /** Forza del segnale (|z|, |distanza VWAP|%, forza della rottura), per capire quanto "pesava". */
  signal?: number;
}

const MAX_RECORDS_PER_CALL = 60;

/** Elementi di `labView` che non compaiono in `realView`, per chiave. Pura. */
export function missingFrom<T>(labView: T[], realView: T[], keyOf: (t: T) => string): T[] {
  const present = new Set(realView.map(keyOf));
  return labView.filter((t) => !present.has(keyOf(t)));
}

/** Un solo record per (strategia, soggetto, motivo): tiene il segnale più forte. Pura. */
export function dedupeSkips(records: SkipRecord[]): SkipRecord[] {
  const out = new Map<string, SkipRecord>();
  for (const r of records) {
    const k = `${r.strategyId}|${r.subject}|${r.reason}`;
    const prev = out.get(k);
    if (!prev) {
      out.set(k, r);
      continue;
    }
    if ((r.signal ?? 0) > (prev.signal ?? 0)) out.set(k, { ...r, detail: r.detail ?? prev.detail });
  }
  return [...out.values()];
}

export async function saveSkippedSignals(tradingDate: string, records: SkipRecord[], now: Date): Promise<number> {
  const unique = dedupeSkips(records).slice(0, MAX_RECORDS_PER_CALL);
  for (const r of unique) {
    await db()`
      INSERT INTO skipped_signals (trading_date, strategy_id, subject, reason, detail, signal, first_seen, last_seen, ticks)
      VALUES (${tradingDate}, ${r.strategyId}, ${r.subject}, ${r.reason}, ${r.detail ?? null}, ${r.signal ?? null},
              ${now.toISOString()}, ${now.toISOString()}, 1)
      ON CONFLICT (trading_date, strategy_id, subject, reason) DO UPDATE SET
        last_seen = EXCLUDED.last_seen,
        ticks = skipped_signals.ticks + 1,
        detail = COALESCE(EXCLUDED.detail, skipped_signals.detail),
        signal = GREATEST(COALESCE(skipped_signals.signal, 0), COALESCE(EXCLUDED.signal, 0))
    `;
  }
  return unique.length;
}

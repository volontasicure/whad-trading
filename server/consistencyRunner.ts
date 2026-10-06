// Esecutore del controllo di coerenza dentro il tick (api/cron/tick.ts).
//
// Perché qui e non solo in scripts/monitor.ts: gli schedule di GitHub Actions girano 1-3 volte al
// giorno invece di ogni 30 minuti (stesso degrado già visto con eod-close.yml e il backup di
// tick.yml — verificato sui run del 25/9-6/10), mentre il tick arriva ogni 5 minuti da
// cron-job.org. Il controllo viaggia quindi con il tick.
//
// Garanzie, in ordine di importanza:
//   - non può mai disturbare l'esecuzione: chiamato dopo la scrittura di tick_log, dentro un
//     try/catch del chiamante, con un timeout proprio e saltando il giro se il tick è già lento (un Alpaca lento non blocca la risposta);
//   - non gira a ogni tick ma ogni ~10 minuti (MIN_CHECK_INTERVAL_MS);
//   - avvisa solo per anomalie presenti in due controlli consecutivi, senza ripetere lo stesso
//     avviso per 3 ore (decideAlerts in realVsLab.ts);
//   - lo stato sta in lab_state (strategy_id "monitor"), nessuna migrazione dello schema.
//
// L'email richiede RESEND_API_KEY nell'ambiente Vercel. Se manca, l'anomalia resta nello stato
// salvato e nei log della funzione e il controllo riprova al giro successivo: non si perde, ma
// nessuno la riceve in posta finché la variabile non è impostata.

import { db } from "./db.js";
import { sendAlertEmail } from "./alertEmail.js";
import { runConsistencyChecks } from "./consistencyCheck.js";
import { EMPTY_MONITOR_STATE, decideAlerts, isCheckDue, type MonitorState } from "./realVsLab.js";

const STATE_STRATEGY_ID = "monitor";
const STATE_KEY = "consistency";
const CHECK_TIMEOUT_MS = 5_000;
/**
 * Il limite di durata della funzione su Vercel non è noto da qui: se il tick ha già impiegato più
 * di così, il controllo salta il giro invece di rischiare di far scadere la risposta. Un controllo
 * che viene sempre saltato o va sempre in timeout si vede in `consistency` nella risposta del tick e
 * in `lastError` nello stato salvato.
 */
const SKIP_IF_TICK_SLOWER_THAN_MS = 4_000;

interface StoredState extends MonitorState {
  /** Ultimo riepilogo, solo per ispezione a mano (SELECT su lab_state). */
  lines?: string[];
  lastError?: string | null;
}

async function loadState(tradingDate: string): Promise<StoredState> {
  const rows = (await db()`
    SELECT value FROM lab_state WHERE strategy_id = ${STATE_STRATEGY_ID} AND trading_date = ${tradingDate} AND key = ${STATE_KEY}
  `) as unknown as { value: StoredState }[];
  return rows[0]?.value ?? { ...EMPTY_MONITOR_STATE };
}

async function saveState(tradingDate: string, state: StoredState): Promise<void> {
  await db()`
    INSERT INTO lab_state (strategy_id, trading_date, key, value, updated_at)
    VALUES (${STATE_STRATEGY_ID}, ${tradingDate}, ${STATE_KEY}, ${JSON.stringify(state)}::jsonb, now())
    ON CONFLICT (strategy_id, trading_date, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout dopo ${ms / 1000}s`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

/** Restituisce una nota breve per la risposta del tick. Non lancia mai. */
export async function runConsistencyIfDue(ctx: { now: Date; tradingDate: string; sessionOpenUtc: string; startedAtMs: number }): Promise<string> {
  const nowMs = ctx.now.getTime();
  if (Date.now() - ctx.startedAtMs > SKIP_IF_TICK_SLOWER_THAN_MS) return "controllo: saltato (tick già lento)";
  let state: StoredState;
  try {
    state = await loadState(ctx.tradingDate);
    if (!isCheckDue(state, nowMs)) return "controllo: non dovuto";
  } catch (err) {
    return `controllo: stato non leggibile (${(err as Error).message})`;
  }

  let result: Awaited<ReturnType<typeof runConsistencyChecks>>;
  try {
    result = await withTimeout(runConsistencyChecks({ tradingDate: ctx.tradingDate, sessionOpenUtc: ctx.sessionOpenUtc }), CHECK_TIMEOUT_MS);
  } catch (err) {
    // Si segna comunque il tentativo: un errore persistente non deve far ripartire il controllo a ogni tick.
    try {
      await saveState(ctx.tradingDate, { ...state, ranAt: ctx.now.toISOString(), lastError: (err as Error).message });
    } catch {
      /* best-effort */
    }
    return `controllo: errore (${(err as Error).message})`;
  }

  const { toAlert, next } = decideAlerts(result.anomalies, state, nowMs);

  let mailNote = "";
  if (toAlert.length > 0) {
    const body = [
      `WHAD Trading — ${toAlert.length} anomalia/e confermata/e in due controlli consecutivi (${ctx.now.toISOString()})`,
      "",
      ...toAlert.flatMap((a) => [`• ${a.summary}`, `  Suggerimento: ${a.suggestion}`, ""]),
      "Riepilogo:",
      ...result.lines.map((l) => `  ${l}`),
    ];
    const sent = await sendAlertEmail(`⚠ WHAD Trading — ${toAlert.length} anomalia/e sul conto reale`, body);
    if (sent.sent) {
      mailNote = ", email inviata";
    } else {
      // Non segnata come avvisata: riproverà al giro successivo invece di perdersi.
      for (const a of toAlert) delete next.alerted[a.key];
      mailNote = `, email NON inviata (${sent.reason})`;
      console.error(`Anomalie confermate ma email non inviata: ${sent.reason}\n${toAlert.map((a) => a.summary).join("\n")}`);
    }
  }

  try {
    await saveState(ctx.tradingDate, { ...next, lines: result.lines, lastError: null });
  } catch (err) {
    return `controllo: eseguito ma stato non salvato (${(err as Error).message})`;
  }
  return `controllo: ${result.anomalies.length} anomalie, ${toAlert.length} segnalate${mailNote}`;
}

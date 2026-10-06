// Controllo di sanità sui tre laboratori, pensato per girare ogni 30 minuti in orario di
// mercato via GitHub Actions (.github/workflows/monitor.yml) — verifica come si stanno
// comportando le tre strategie e segnala anomalie. Se ne trova, manda una mail via Resend
// (RESEND_API_KEY) a ALERT_EMAIL con l'elenco e i suggerimenti; l'esito resta comunque nel
// log della Action (exit code 1 se trova anomalie, così il run risulta "fallito" ed è
// visibile a colpo d'occhio anche senza aprire la mail). Parte 3 (avviare un fix dalla
// mail) non ancora implementata.
//
// A mercato chiuso (stesso /v2/clock usato da api/cron/tick.ts, non solo la finestra oraria
// del cron) salta le anomalie che assumono mercato aperto (freschezza tick, tetti posizioni),
// ma stampa comunque "Performance di oggi" — così il risultato della giornata resta leggibile
// anche dopo la chiusura, non solo mentre il mercato è ancora aperto.
//
// Dal 6/10/2026 controlla anche la coerenza tra conto reale e laboratori (checkRealVsLab,
// logica pura in server/realVsLab.ts), sia a mercato aperto sia dopo la chiusura:
// riconciliazione broker ↔ real_positions, trade reali senza gemello nel lab, scostamento del
// realizzato di oggi rispetto ai lab scalati per capitale e peso.

import { readFileSync } from "node:fs";
import path from "node:path";
import { neon } from "@neondatabase/serverless";
import { alpacaFetch } from "../server/alpaca.js";
import { fetchMarketSession } from "../server/marketHours.js";
import { MAX_POSITIONS as ORB_MAX_POSITIONS, STRATEGY_ID as ORB_STRATEGY_ID } from "../server/orb.js";
import { MAX_POSITIONS as VWAP_MAX_POSITIONS, STRATEGY_ID as VWAP_STRATEGY_ID } from "../server/vwapReversion.js";
import { MAX_PAIRS, STRATEGY_ID as PAIRS_STRATEGY_ID } from "../server/pairsTrading.js";
import { computeEligibility, computeWeights, LAB_CAPITAL_REF } from "../server/strategyAllocation.js";
import {
  computeDeviation,
  findUnmatchedRealTrades,
  reconcilePositions,
  type RealClosedTrade,
  type Side,
  type TradeKey,
} from "../server/realVsLab.js";

function loadEnvLocal() {
  const p = path.resolve(process.cwd(), ".env.local");
  let content: string;
  try {
    content = readFileSync(p, "utf8");
  } catch {
    return;
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvLocal();

const POSTGRES_URL = process.env.POSTGRES_URL;
if (!POSTGRES_URL) {
  console.error("POSTGRES_URL mancante.");
  process.exit(1);
}
const sql = neon(POSTGRES_URL);

interface AlpacaClock {
  is_open: boolean;
  next_open: string;
}

const STRATEGY_LABELS: Record<string, string> = {
  [ORB_STRATEGY_ID]: "ORB",
  [VWAP_STRATEGY_ID]: "VWAP reversion",
  [PAIRS_STRATEGY_ID]: "Pairs trading",
};

const anomalies: { summary: string; suggestion: string }[] = [];
function flag(summary: string, suggestion: string) {
  anomalies.push({ summary, suggestion });
}
const perfLines: string[] = [];

const ALERT_EMAIL = "nicolaforria@gmail.com";

/** Invio best-effort: un problema con l'email non deve far sparire la segnalazione (resta comunque nel log/exit code). */
async function sendAlertEmail(perfSummary: string[]): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("RESEND_API_KEY mancante: salto l'invio email, l'anomalia resta comunque nel log di questa Action.");
    return;
  }
  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null;

  const lines: string[] = [];
  lines.push(`WHAD Trading — ${anomalies.length} anomalia/e rilevata/e alle ${new Date().toISOString()}`, "");
  for (const a of anomalies) {
    lines.push(`• ${a.summary}`);
    lines.push(`  Suggerimento: ${a.suggestion}`, "");
  }
  if (perfSummary.length > 0) {
    lines.push("Performance di oggi:", ...perfSummary.map((l) => `  ${l}`), "");
  }
  if (runUrl) lines.push(`Log completo: ${runUrl}`);

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "WHAD Trading <onboarding@resend.dev>",
        to: [ALERT_EMAIL],
        subject: `⚠ WHAD Trading — ${anomalies.length} anomalia/e rilevata/e`,
        text: lines.join("\n"),
      }),
    });
    if (!res.ok) {
      console.error(`Invio email fallito: Resend ha risposto ${res.status} ${await res.text().catch(() => "")}`);
      return;
    }
    console.log(`Email di alert inviata a ${ALERT_EMAIL}.`);
  } catch (err) {
    console.error("Invio email fallito:", (err as Error).message);
  }
}

/**
 * Riepilogo chiuse/P&L/aperte per le 3 strategie sulla trading_date data — non dipende dal
 * mercato aperto (legge solo posizioni già chiuse più il conteggio di quelle ancora aperte),
 * quindi funziona anche a mercato chiuso per leggere il risultato finale della giornata.
 */
async function printTodayPerformance(tradingDate: string): Promise<string[]> {
  const openCounts = (await sql.query(
    `SELECT strategy_id, count(*)::int AS n FROM lab_positions WHERE status = 'open' GROUP BY strategy_id`
  )) as { strategy_id: string; n: number }[];
  const countByStrategy: Record<string, number> = {};
  for (const row of openCounts) countByStrategy[row.strategy_id] = row.n;
  const pairsLegsOpen = countByStrategy[PAIRS_STRATEGY_ID] ?? 0;

  const session = await fetchMarketSession(tradingDate);
  if (!session) return [];

  const perf = (await sql.query(
    `SELECT strategy_id, coalesce(sum(realized_pnl), 0)::float8 AS pnl, count(*)::int AS trades
     FROM lab_positions WHERE status = 'closed' AND exit_time >= $1 GROUP BY strategy_id`,
    [session.openUtc]
  )) as { strategy_id: string; pnl: number; trades: number }[];

  // Diagnostica: scomposizione delle chiusure per motivo (stop vs target vs eod, ecc.) — senza
  // questo "N chiuse, P&L X" non dice se X viene da un filtro d'ingresso troppo permissivo
  // (tanti stop) o da normale rumore. Vedi ExitDecision in server/{orb,vwapReversion,pairsTrading}.ts.
  const reasonRows = (await sql.query(
    `SELECT strategy_id, coalesce(exit_reason, 'n/d') AS reason, count(*)::int AS n
     FROM lab_positions WHERE status = 'closed' AND exit_time >= $1 GROUP BY strategy_id, reason`,
    [session.openUtc]
  )) as { strategy_id: string; reason: string; n: number }[];
  const reasonsByStrategy: Record<string, string> = {};
  for (const id of [ORB_STRATEGY_ID, VWAP_STRATEGY_ID, PAIRS_STRATEGY_ID]) {
    const rows = reasonRows.filter((r) => r.strategy_id === id);
    if (rows.length > 0) reasonsByStrategy[id] = rows.map((r) => `${r.reason} ${r.n}`).join(", ");
  }

  console.log("\nPerformance di oggi:");
  const lines: string[] = [];
  for (const id of [ORB_STRATEGY_ID, VWAP_STRATEGY_ID, PAIRS_STRATEGY_ID]) {
    const row = perf.find((p) => p.strategy_id === id);
    const openNow = id === PAIRS_STRATEGY_ID ? `${pairsLegsOpen} gambe aperte` : `${countByStrategy[id] ?? 0} aperte`;
    const reasons = reasonsByStrategy[id];
    const line = `${STRATEGY_LABELS[id]}: ${row?.trades ?? 0} chiuse${reasons ? ` (${reasons})` : ""}, P&L ${row?.pnl ?? 0} | ${openNow}`;
    console.log(`  ${line}`);
    lines.push(line);
  }

  // Diagnostica pairs trading: z-score massimo raggiunto oggi per coppia candidata, anche per
  // quelle mai entrate — distingue "soglia (2.0) sfiorata" da "coppie poco correlate in pratica".
  const zRows = (await sql.query(
    `SELECT pair_key, max(abs(z))::float8 AS max_abs_z
     FROM pairs_zscore_log WHERE trading_date = $1 GROUP BY pair_key ORDER BY max_abs_z DESC LIMIT 5`,
    [tradingDate]
  )) as { pair_key: string; max_abs_z: number }[];
  if (zRows.length > 0) {
    const zLine = `Pairs — z massimo oggi per coppia (soglia ingresso 2.0): ${zRows.map((r) => `${r.pair_key} ${r.max_abs_z.toFixed(2)}`).join(", ")}`;
    console.log(`  ${zLine}`);
    lines.push(zLine);
  }

  return lines;
}


interface AlpacaPositionRow {
  symbol: string;
  qty: string;
  side: "long" | "short";
}

interface AlpacaAccountRow {
  equity: string;
}

const fmt = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(0)}$`;

/**
 * Coerenza tra conto reale e laboratori (server/realVsLab.ts): riconciliazione broker ↔ DB,
 * trade reali senza gemello nel lab, scostamento di P&L realizzato oggi. Gira sia a mercato
 * aperto sia dopo la chiusura — dopo la chiusura è proprio il momento in cui si vede se
 * l'EOD ha davvero chiuso e registrato tutto.
 */
async function checkRealVsLab(tradingDate: string): Promise<string[]> {
  const lines: string[] = [];

  // --- 1. Riconciliazione broker ↔ real_positions ---
  const [brokerRows, dbOpenRows] = await Promise.all([
    alpacaFetch<AlpacaPositionRow[]>("/v2/positions"),
    sql.query(
      `SELECT symbol, side, qty::float8 AS qty FROM real_positions WHERE status = 'open'`
    ) as unknown as Promise<{ symbol: string; side: Side; qty: number }[]>,
  ]);
  const broker = brokerRows.map((p) => {
    const q = Math.abs(Number(p.qty));
    return { symbol: p.symbol, signedQty: p.side === "short" ? -q : q };
  });
  const mismatches = reconcilePositions(broker, dbOpenRows);
  for (const m of mismatches) {
    flag(
      `[REALE] ${m.symbol}: sul broker ${m.brokerQty} azioni, nel DB ${m.dbQty}`,
      m.dbQty === 0
        ? "Posizione presente su Alpaca ma non registrata in real_positions (stesso schema della doppia chiusura di BA del 30/9): nessuna regola la gestisce. Verifica gli ordini di oggi su quel simbolo e chiudila/registrala a mano."
        : m.brokerQty === 0
          ? "Il DB la considera aperta ma sul broker non c'è più: chiusura (bracket, EOD o manuale) non registrata. Recupera il fill da /v2/orders?status=closed e aggiorna real_positions, altrimenti il realized non viene contato."
          : "Quantità diversa tra broker e DB: probabile fill parziale o doppio ordine. Controlla gli ordini di oggi su quel simbolo."
    );
  }
  lines.push(`Riconciliazione broker↔DB: ${mismatches.length === 0 ? "OK" : `${mismatches.length} differenze`} (${broker.length} posizioni sul broker)`);

  const session = await fetchMarketSession(tradingDate);
  if (!session) return lines;

  // --- 2. Trade reali chiusi oggi senza un gemello nel lab ---
  const [realClosedRows, labTouchedRows] = await Promise.all([
    sql.query(
      `SELECT strategy_id, symbol, side, realized_pnl::float8 AS realized_pnl, exit_reason
       FROM real_positions WHERE status = 'closed' AND exit_time >= $1`,
      [session.openUtc]
    ) as unknown as Promise<{ strategy_id: string; symbol: string; side: Side; realized_pnl: number; exit_reason: string | null }[]>,
    sql.query(
      `SELECT DISTINCT strategy_id, symbol, side FROM lab_positions
       WHERE status = 'open' OR exit_time >= $1 OR entry_time >= $1`,
      [session.openUtc]
    ) as unknown as Promise<{ strategy_id: string; symbol: string; side: Side }[]>,
  ]);
  const realClosed: RealClosedTrade[] = realClosedRows.map((r) => ({
    strategyId: r.strategy_id,
    symbol: r.symbol,
    side: r.side,
    realizedPnl: r.realized_pnl ?? 0,
    exitReason: r.exit_reason,
  }));
  const labTouched: TradeKey[] = labTouchedRows.map((r) => ({ strategyId: r.strategy_id, symbol: r.symbol, side: r.side }));
  const unmatched = findUnmatchedRealTrades(realClosed, labTouched);
  for (const t of unmatched) {
    flag(
      `[REALE] Trade ${t.strategyId} ${t.side} ${t.symbol} chiuso oggi (${fmt(t.realizedPnl)}, uscita: ${t.exitReason ?? "n/d"}) senza nessuna posizione corrispondente nel lab`,
      "Il conto reale ha operato su qualcosa che la strategia nel lab non ha mai deciso: controlla in server/realExecution.ts come è nato l'ingresso (posizione ereditata da un giorno precedente? riconciliazione bracket? ordine duplicato?)."
    );
  }

  // --- 3. Scostamento di P&L realizzato oggi, reale vs lab scalato ---
  const [account, labRealizedRows, eligibility] = await Promise.all([
    alpacaFetch<AlpacaAccountRow>("/v2/account"),
    sql.query(
      `SELECT strategy_id, coalesce(sum(realized_pnl), 0)::float8 AS pnl
       FROM lab_positions WHERE status = 'closed' AND exit_time >= $1 GROUP BY strategy_id`,
      [session.openUtc]
    ) as unknown as Promise<{ strategy_id: string; pnl: number }[]>,
    computeEligibility(tradingDate),
  ]);
  const weights = computeWeights(eligibility);
  const labByStrategy = new Map(labRealizedRows.map((r) => [r.strategy_id, r.pnl]));
  const realByStrategy = new Map<string, number>();
  for (const t of realClosed) realByStrategy.set(t.strategyId, (realByStrategy.get(t.strategyId) ?? 0) + t.realizedPnl);

  const strategyIds = [ORB_STRATEGY_ID, VWAP_STRATEGY_ID, PAIRS_STRATEGY_ID];
  const deviation = computeDeviation(
    strategyIds.map((id) => ({
      strategyId: id,
      labRealized: labByStrategy.get(id) ?? 0,
      realRealized: realByStrategy.get(id) ?? 0,
      weight: weights[id] ?? 0,
    })),
    Number(account.equity),
    LAB_CAPITAL_REF
  );
  const detail = deviation.byStrategy
    .filter((r) => Math.abs(r.expected) >= 1 || Math.abs(r.actual) >= 1)
    .map((r) => `${STRATEGY_LABELS[r.strategyId]} atteso ${fmt(r.expected)} / reale ${fmt(r.actual)}`)
    .join("; ");
  const summary = `Reale vs lab, realizzato oggi: atteso ${fmt(deviation.expected)}, reale ${fmt(deviation.actual)}, scostamento ${fmt(deviation.gap)} (soglia ±${deviation.threshold.toFixed(0)}$)${detail ? ` — ${detail}` : ""}`;
  lines.push(summary);
  if (deviation.breached) {
    flag(
      `[REALE] ${summary}`,
      "Il conto reale non sta replicando i lab ammessi oggi. Le cause viste finora sono tutte di esecuzione, non di strategia: size diversa dal previsto, ordini doppi, chiusure non registrate, posizioni ereditate da strategie a peso zero. Guarda prima le altre anomalie [REALE] di questa mail, poi tick_log e gli ordini Alpaca di oggi."
    );
  }

  return lines;
}

async function run() {
  const clock = await alpacaFetch<AlpacaClock>("/v2/clock");
  const now = new Date();
  const tradingDate = now.toISOString().slice(0, 10);

  if (!clock.is_open) {
    console.log(`Mercato chiuso (prossima apertura ${clock.next_open}).`);
    // Le anomalie sotto (freschezza tick, tetti posizioni, gambe orfane) assumono mercato
    // aperto e non hanno senso fuori orario — ma il risultato della giornata resta leggibile
    // anche a mercato chiuso, quindi lo stampiamo comunque invece di uscire a mani vuote.
    const closedPerf = await printTodayPerformance(tradingDate);
    const closedRealLines = await checkRealVsLab(tradingDate);
    for (const l of closedRealLines) console.log(`  ${l}`);
    if (anomalies.length > 0) {
      for (const a of anomalies) console.log(` - ${a.summary}\n   Suggerimento: ${a.suggestion}`);
      process.exitCode = 1;
      await sendAlertEmail([...closedPerf, ...closedRealLines]);
    }
    return;
  }

  console.log(`Mercato aperto — controllo alle ${now.toISOString()}\n`);

  // --- Freschezza del tick: il tick principale gira ogni 5 minuti in orario di mercato ---
  const lastTickRows = (await sql.query(
    `SELECT ran_at, note FROM tick_log ORDER BY ran_at DESC LIMIT 1`
  )) as { ran_at: string; note: string | null }[];
  if (lastTickRows.length === 0) {
    flag("Nessuna riga in tick_log", "Il tick principale non ha mai scritto nulla: verifica che il workflow GitHub 'Market tick' sia abilitato e che TICK_SECRET sia impostato correttamente su Vercel e su GitHub.");
  } else {
    const ageMinutes = (now.getTime() - new Date(lastTickRows[0].ran_at).getTime()) / 60_000;
    if (ageMinutes > 10) {
      flag(
        `Ultimo tick di ${ageMinutes.toFixed(0)} minuti fa, nonostante il mercato sia aperto`,
        "Il tick dovrebbe girare ogni 5 minuti. Controlla i log del workflow 'Market tick' su GitHub Actions: probabile causa un errore di autenticazione Alpaca (chiavi ruotate?) o un problema del database."
      );
    }
    console.log(`Ultimo tick: ${lastTickRows[0].ran_at} (${ageMinutes.toFixed(0)} min fa) — ${lastTickRows[0].note ?? "(nessuna nota)"}`);
  }

  // --- Posizioni aperte per strategia: conteggio contro i limiti dichiarati ---
  const openCounts = (await sql.query(
    `SELECT strategy_id, count(*)::int AS n FROM lab_positions WHERE status = 'open' GROUP BY strategy_id`
  )) as { strategy_id: string; n: number }[];
  const countByStrategy: Record<string, number> = {};
  for (const row of openCounts) countByStrategy[row.strategy_id] = row.n;

  const orbOpen = countByStrategy[ORB_STRATEGY_ID] ?? 0;
  const vwapOpen = countByStrategy[VWAP_STRATEGY_ID] ?? 0;
  const pairsLegsOpen = countByStrategy[PAIRS_STRATEGY_ID] ?? 0;
  if (orbOpen > ORB_MAX_POSITIONS) flag(`ORB ha ${orbOpen} posizioni aperte (limite ${ORB_MAX_POSITIONS})`, "Controlla server/orb.ts (decideEntries) e la logica di conteggio degli slot liberi in api/cron/tick.ts: il tetto massimo di posizioni non dovrebbe mai essere superabile.");
  if (vwapOpen > VWAP_MAX_POSITIONS) flag(`VWAP reversion ha ${vwapOpen} posizioni aperte (limite ${VWAP_MAX_POSITIONS})`, "Controlla server/vwapReversion.ts (decideEntries) e la logica di conteggio degli slot liberi in api/cron/tick.ts.");
  if (pairsLegsOpen > MAX_PAIRS * 2) flag(`Pairs trading ha ${pairsLegsOpen} gambe aperte (limite ${MAX_PAIRS} coppie = ${MAX_PAIRS * 2} gambe)`, "Controlla server/pairsTrading.ts (decideEntries) e il conteggio degli slot liberi in api/cron/tick.ts.");

  // --- Gambe orfane: ogni coppia deve avere esattamente 2 gambe aperte, mai 1 o 3+ ---
  const pairLegCounts = (await sql.query(
    `SELECT pair_key, count(*)::int AS n FROM lab_positions WHERE status = 'open' AND strategy_id = $1 AND pair_key IS NOT NULL GROUP BY pair_key`,
    [PAIRS_STRATEGY_ID]
  )) as { pair_key: string; n: number }[];
  for (const row of pairLegCounts) {
    if (row.n !== 2) {
      flag(
        `Coppia ${row.pair_key} ha ${row.n} gambe aperte invece di 2`,
        "Gamba orfana: server/pairsTrading.ts (decideExits) si rifiuta di valutare l'uscita per una gamba senza partner. Verifica come è stata creata (rete di sicurezza EOD? chiusura manuale di una sola gamba?) e chiudila manualmente se necessario."
      );
    }
  }

  // --- Valori non validi su posizioni aperte ---
  const invalidRows = (await sql.query(
    `SELECT id, symbol, qty::float8 AS qty, entry_price::float8 AS entry_price FROM lab_positions
     WHERE status = 'open' AND (qty IS NULL OR qty <= 0 OR entry_price IS NULL OR entry_price <= 0)`
  )) as { id: number; symbol: string; qty: number | null; entry_price: number | null }[];
  for (const row of invalidRows) {
    flag(
      `Posizione #${row.id} (${row.symbol}) ha qty=${row.qty} entry_price=${row.entry_price}`,
      "Valore non valido su una posizione aperta: probabile bug nella logica di ingresso di una delle tre strategie, o un problema nei dati di prezzo ricevuti da Alpaca quel tick. Controlla api/cron/tick.ts per quel simbolo/orario."
    );
  }

  // --- Stessi controlli su real_positions (conto Alpaca reale, ambiente paper): stesso
  // schema di lab_positions, stessi tetti per strategia, vedi server/realExecution.ts ---
  const realOpenCounts = (await sql.query(
    `SELECT strategy_id, count(*)::int AS n FROM real_positions WHERE status = 'open' GROUP BY strategy_id`
  )) as { strategy_id: string; n: number }[];
  const realCountByStrategy: Record<string, number> = {};
  for (const row of realOpenCounts) realCountByStrategy[row.strategy_id] = row.n;
  const realOrbOpen = realCountByStrategy[ORB_STRATEGY_ID] ?? 0;
  const realVwapOpen = realCountByStrategy[VWAP_STRATEGY_ID] ?? 0;
  const realPairsLegsOpen = realCountByStrategy[PAIRS_STRATEGY_ID] ?? 0;
  if (realOrbOpen > ORB_MAX_POSITIONS) flag(`[REALE] ORB ha ${realOrbOpen} posizioni aperte (limite ${ORB_MAX_POSITIONS})`, "Controlla server/realExecution.ts: il tetto massimo di posizioni non dovrebbe mai essere superabile sul conto reale.");
  if (realVwapOpen > VWAP_MAX_POSITIONS) flag(`[REALE] VWAP reversion ha ${realVwapOpen} posizioni aperte (limite ${VWAP_MAX_POSITIONS})`, "Controlla server/realExecution.ts.");
  if (realPairsLegsOpen > MAX_PAIRS * 2) flag(`[REALE] Pairs trading ha ${realPairsLegsOpen} gambe aperte (limite ${MAX_PAIRS} coppie = ${MAX_PAIRS * 2} gambe)`, "Controlla server/realExecution.ts.");

  const realPairLegCounts = (await sql.query(
    `SELECT pair_key, count(*)::int AS n FROM real_positions WHERE status = 'open' AND strategy_id = $1 AND pair_key IS NOT NULL GROUP BY pair_key`,
    [PAIRS_STRATEGY_ID]
  )) as { pair_key: string; n: number }[];
  for (const row of realPairLegCounts) {
    if (row.n !== 2) {
      flag(
        `[REALE] Coppia ${row.pair_key} ha ${row.n} gambe aperte invece di 2`,
        "Gamba orfana sul conto reale: verifica server/realExecution.ts e chiudila manualmente su Alpaca se necessario — qui sono soldi (paper) veri, non solo un record nel DB."
      );
    }
  }

  const realInvalidRows = (await sql.query(
    `SELECT id, symbol, qty::float8 AS qty, entry_price::float8 AS entry_price FROM real_positions
     WHERE status = 'open' AND (qty IS NULL OR qty <= 0 OR entry_price IS NULL OR entry_price <= 0)`
  )) as { id: number; symbol: string; qty: number | null; entry_price: number | null }[];
  for (const row of realInvalidRows) {
    flag(
      `[REALE] Posizione #${row.id} (${row.symbol}) ha qty=${row.qty} entry_price=${row.entry_price}`,
      "Valore non valido su una posizione reale aperta: controlla server/realExecution.ts e l'ordine corrispondente su Alpaca."
    );
  }

  // --- Performance di oggi per strategia (informativo, non un'anomalia) ---
  perfLines.push(...(await printTodayPerformance(tradingDate)));

  // --- Coerenza conto reale ↔ laboratori (server/realVsLab.ts) ---
  const realLines = await checkRealVsLab(tradingDate);
  for (const l of realLines) console.log(`  ${l}`);
  perfLines.push(...realLines);

  console.log(`\nAnomalie rilevate: ${anomalies.length}`);
  for (const a of anomalies) {
    console.log(` - ${a.summary}`);
    console.log(`   Suggerimento: ${a.suggestion}`);
  }

  if (anomalies.length > 0) {
    process.exitCode = 1;
    await sendAlertEmail(perfLines);
  }
}

run().catch((err) => {
  console.error("Controllo fallito:", err);
  process.exit(1);
});

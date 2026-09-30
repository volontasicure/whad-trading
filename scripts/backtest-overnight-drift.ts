// Backtest locale per "overnight_drift" (server/overnightDrift.ts, non ancora wired a
// tick.ts/db/schema): rigioca N giorni di mercato usando daily_bars già persistito in DB
// (open/close per simbolo), senza toccare lab_positions/lab_state di produzione e senza
// chiamare Alpaca — a differenza di scripts/backtest.ts, che serve alle tre strategie
// intraday, qui basta un prezzo di apertura e uno di chiusura per giorno.
//
// Copertura dati: daily_bars ha almeno 70 sedute per ogni simbolo dell'universo (alcuni
// backfillati solo da metà giugno 2026) — le finestre qui sono di 30 sedute, non 39 come negli
// altri backtest, per restare sempre dentro quella copertura minima con margine.
//
// Uso: npx tsx scripts/backtest-overnight-drift.ts [giorni=30] [prima_del_YYYY-MM-DD]
// Il secondo argomento ancora la finestra PRIMA di quella data invece che su oggi — per la
// finestra fuori campione.

import { readFileSync } from "node:fs";
import path from "node:path";
import { neon } from "@neondatabase/serverless";
import { UNIVERSE_SYMBOLS } from "../server/universe.js";
import { decideOvernightEntries, overnightPnl, CAPITAL, TOP_K, type DailyOpenClose, type Mode } from "../server/overnightDrift.js";

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
if (!POSTGRES_URL) throw new Error("POSTGRES_URL non configurata (.env.local mancante o incompleto)");
const sql = neon(POSTGRES_URL);

interface DailyRow {
  trading_date: string | Date;
  symbol: string;
  open: string;
  close: string;
}

/**
 * @neondatabase/serverless deserializza le colonne DATE come oggetti Date costruiti dai
 * componenti locali (new Date(anno, mese, giorno)) — su questa macchina (Europe/Rome, UTC+2)
 * .toISOString() sposterebbe la data indietro di un giorno (mezzanotte locale = 22:00 UTC del
 * giorno prima). Diagnosticato il 29/9/2026 sulla tabella sessions (vedi CLAUDE.md). Fix: leggere
 * i componenti locali, mai convertire in UTC.
 */
function toDateStr(d: string | Date): string {
  if (typeof d === "string") return d.slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function loadDailyBars(beforeDateIso: string, days: number): Promise<{ dates: string[]; bySymbolByDate: Map<string, Map<string, DailyOpenClose>> }> {
  const rows = (await sql.query(
    `SELECT trading_date, symbol, open, close FROM daily_bars
     WHERE symbol = ANY($1::text[]) AND trading_date < $2::date
     ORDER BY trading_date DESC LIMIT $3`,
    [UNIVERSE_SYMBOLS, beforeDateIso, UNIVERSE_SYMBOLS.length * (days + 5)]
  )) as DailyRow[];

  const byDate = new Map<string, Map<string, DailyOpenClose>>();
  for (const r of rows) {
    const d = toDateStr(r.trading_date);
    if (!byDate.has(d)) byDate.set(d, new Map());
    byDate.get(d)!.set(r.symbol, { symbol: r.symbol, open: Number(r.open), close: Number(r.close) });
  }
  const dates = [...byDate.keys()].sort().slice(-(days + 1)); // +1: serve il giorno dopo l'ultimo per l'apertura di uscita
  return { dates, bySymbolByDate: byDate };
}

export interface TradeRecord {
  date: string;
  symbol: string;
  side: string;
  pnl: number;
}

export async function runOneWindow(
  beforeDateIso: string,
  days: number,
  mode: Mode,
  topK: number = TOP_K
): Promise<{ firstDay: string; lastDay: string; entries: number; pnl: number; days: number; trades: TradeRecord[] }> {
  const { dates, bySymbolByDate } = await loadDailyBars(beforeDateIso, days);
  if (dates.length < 2) throw new Error(`dati insufficienti prima di ${beforeDateIso}`);

  let totalPnl = 0;
  let totalEntries = 0;
  let tradingDaysUsed = 0;
  const trades: TradeRecord[] = [];
  // L'ultimo giorno della finestra serve solo come "apertura di domani" per il penultimo:
  // non genera un nuovo ingresso proprio, altrimenti non avremmo dati per chiuderlo.
  for (let i = 0; i < dates.length - 1; i++) {
    const today = dates[i];
    const tomorrow = dates[i + 1];
    const todayBars = bySymbolByDate.get(today)!;
    const tomorrowBars = bySymbolByDate.get(tomorrow)!;

    const bars: DailyOpenClose[] = UNIVERSE_SYMBOLS.map((s) => todayBars.get(s)).filter((b): b is DailyOpenClose => !!b);
    const entries = decideOvernightEntries(bars, mode, CAPITAL, topK);
    tradingDaysUsed++;
    for (const e of entries) {
      const nextOpen = tomorrowBars.get(e.symbol)?.open;
      if (nextOpen == null || nextOpen <= 0) continue; // simbolo senza dati validi domani, salta la posizione
      const pnl = overnightPnl(e, nextOpen);
      totalPnl += pnl;
      totalEntries++;
      trades.push({ date: today, symbol: e.symbol, side: e.side, pnl });
    }
  }

  return { firstDay: dates[0], lastDay: dates[dates.length - 2], entries: totalEntries, pnl: totalPnl, days: tradingDaysUsed, trades };
}

async function run() {
  const days = Number(process.argv[2]) || 30;
  const beforeDateIso = process.argv[3];
  const anchor = beforeDateIso ?? new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

  console.log(`Overnight drift — CAPITAL=${CAPITAL}, TOP_K=${TOP_K} (${TOP_K * 2} posizioni/giorno), finestre di ${days} sedute\n`);

  const modes: Mode[] = ["continuation", "reversal"];
  const results: Record<Mode, { recent: Awaited<ReturnType<typeof runOneWindow>>; oos: Awaited<ReturnType<typeof runOneWindow>> }> = {} as any;

  let oosAnchor: string | null = null;
  for (const mode of modes) {
    console.log(`>>> ${mode}: finestra recente...`);
    const recent = await runOneWindow(anchor, days, mode);
    oosAnchor ??= recent.firstDay;
    console.log(`>>> ${mode}: fuori campione (prima di ${oosAnchor})...`);
    const oos = await runOneWindow(oosAnchor, days, mode);
    results[mode] = { recent, oos };
    console.log(`    recente (${recent.firstDay} -> ${recent.lastDay}, ${recent.days} sedute): ${recent.entries} ingressi, P&L = ${recent.pnl}`);
    console.log(`    fuori campione (${oos.firstDay} -> ${oos.lastDay}, ${oos.days} sedute): ${oos.entries} ingressi, P&L = ${oos.pnl}\n`);
  }

  console.log("=== Riepilogo overnight drift ===");
  console.log("variante".padEnd(16), "recente".padStart(9), "fuori camp.".padStart(12), "  verdetto");
  for (const mode of modes) {
    const { recent, oos } = results[mode];
    const bothPositive = recent.pnl > 0 && oos.pnl > 0;
    const bothNegative = recent.pnl < 0 && oos.pnl < 0;
    const verdict = bothPositive ? "POSITIVA su entrambe" : bothNegative ? "negativa su entrambe" : "misto";
    console.log(mode.padEnd(16), String(recent.pnl).padStart(9), String(oos.pnl).padStart(12), " ", verdict);
  }
  console.log("\nNessuna variante qui sopra è attiva in produzione. Anche 'POSITIVA su entrambe' non basta da sola:");
  console.log("va confrontata con un buy&hold dello stesso periodo (scripts/universe-benchmark.ts) prima di significare qualcosa.");
}

// Guard: esegue il CLI solo se il file è lanciato direttamente, non quando le funzioni sopra
// sono importate da un altro script (es. scripts/overnight-drift-checks.ts).
if (process.argv[1] && process.argv[1].endsWith("backtest-overnight-drift.ts")) {
  run().catch((err) => {
    console.error("Backtest fallito:", err);
    process.exit(1);
  });
}

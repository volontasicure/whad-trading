// Benchmark: quanto avrebbe reso un semplice buy & hold equal-weight dei 40 titoli
// dell'universo in una data finestra — per capire se le perdite di una strategia in backtest
// derivano da un mercato debole o da una strategia che ha perso mentre il sottostante saliva.
// Sola lettura da daily_bars, nessuna chiamata Alpaca. Cambia START_DATE/END_DATE sotto per
// farlo coincidere con la finestra del backtest da confrontare.
// Uso: npx tsx scripts/universe-benchmark.ts

import { readFileSync } from "node:fs";
import path from "node:path";
import { neon } from "@neondatabase/serverless";
import { UNIVERSE_SYMBOLS } from "../server/universe.js";
const CAPITAL = 100_000;

const START_DATE = "2026-07-21";
const END_DATE = "2026-09-14";

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
  console.error("POSTGRES_URL mancante in .env.local.");
  process.exit(1);
}
const sql = neon(POSTGRES_URL);

async function run() {
  const perSymbolCapital = CAPITAL / UNIVERSE_SYMBOLS.length;
  let totalPnl = 0;
  let maxBars = 0;
  const rows: { symbol: string; firstClose: number; lastClose: number; retPct: number; pnl: number }[] = [];

  for (const symbol of UNIVERSE_SYMBOLS) {
    const bars = (await sql.query(
      `SELECT trading_date, close FROM daily_bars WHERE symbol = $1 AND trading_date BETWEEN $2 AND $3 ORDER BY trading_date ASC`,
      [symbol, START_DATE, END_DATE]
    )) as { trading_date: string; close: string }[];
    if (bars.length < 2) {
      console.warn(`  ${symbol}: dati insufficienti (${bars.length} barre) nella finestra, escluso dal calcolo`);
      continue;
    }
    maxBars = Math.max(maxBars, bars.length);
    const firstClose = Number(bars[0].close);
    const lastClose = Number(bars[bars.length - 1].close);
    const retPct = ((lastClose - firstClose) / firstClose) * 100;
    const pnl = perSymbolCapital * (retPct / 100);
    totalPnl += pnl;
    rows.push({ symbol, firstClose, lastClose, retPct, pnl });
  }

  rows.sort((a, b) => b.retPct - a.retPct);

  console.log(`Benchmark buy & hold equal-weight — ${rows.length}/${UNIVERSE_SYMBOLS.length} titoli, ${START_DATE} -> ${END_DATE}`);
  console.log(`Capitale per titolo: ${perSymbolCapital.toFixed(0)} $ (capitale totale ${CAPITAL} $ / ${UNIVERSE_SYMBOLS.length} titoli)\n`);

  console.log("Migliori 5:");
  for (const r of rows.slice(0, 5)) {
    console.log(`  ${r.symbol}: ${r.retPct >= 0 ? "+" : ""}${r.retPct.toFixed(2)}%  (${r.firstClose.toFixed(2)} -> ${r.lastClose.toFixed(2)})`);
  }
  console.log("Peggiori 5:");
  for (const r of rows.slice(-5).reverse()) {
    console.log(`  ${r.symbol}: ${r.retPct >= 0 ? "+" : ""}${r.retPct.toFixed(2)}%  (${r.firstClose.toFixed(2)} -> ${r.lastClose.toFixed(2)})`);
  }

  const up = rows.filter((r) => r.retPct > 0).length;
  const down = rows.filter((r) => r.retPct < 0).length;
  const avgRetPct = rows.reduce((a, r) => a + r.retPct, 0) / rows.length;
  const totalRetPct = (totalPnl / CAPITAL) * 100;
  const daysSpan = maxBars - 1;

  console.log(`\n${up} titoli su ${rows.length} in rialzo, ${down} in ribasso nel periodo`);
  console.log(`Rendimento medio per titolo (non pesato per size posizione): ${avgRetPct >= 0 ? "+" : ""}${avgRetPct.toFixed(2)}%`);
  console.log(
    `Rendimento totale portafoglio equal-weight: ${totalRetPct >= 0 ? "+" : ""}${totalRetPct.toFixed(2)}%  (${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(0)} $ su ${CAPITAL} $)`
  );
  if (daysSpan > 0) {
    const avgDailyPct = totalRetPct / daysSpan;
    console.log(`Media per seduta (~${daysSpan} intervalli tra prima e ultima barra): ${avgDailyPct >= 0 ? "+" : ""}${avgDailyPct.toFixed(3)}% al giorno`);
  }
}

run().catch((err) => {
  console.error("Benchmark fallito:", err);
  process.exit(1);
});

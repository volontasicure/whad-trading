// Genera src/data/backtestResults.ts: i numeri REALI della scheda "Backtest" di StrategyView/LabView
// (prima erano valori finti scritti a mano in mockData.ts). Rigioca N sedute storiche con la
// configurazione di PRODUZIONE (filtro di trend VWAP spento — il backtest di default lo tiene
// acceso) e deduce i costi di esecuzione (default 0,023% per lato, misurato sui fill reali).
// È uno snapshot, non un dato live: va rilanciato dopo ogni modifica di strategia/parametri.
// Uso: npx tsx scripts/gen-backtest-card.mjs [giorni] [ancora-YYYY-MM-DD]
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const days = Number(process.argv[2]) || 130;
const anchor = process.argv[3] || new Date().toISOString().slice(0, 10); // l'ancora è esclusa
const CAPITAL = 100_000;
const jsonPath = path.join(mkdtempSync(path.join(tmpdir(), "bt-card-")), "result.json");

const r = spawnSync("npx", ["tsx", "scripts/backtest.ts", String(days), anchor], {
  env: { ...process.env, EXP_VWAP_TREND: "0", BACKTEST_JSON: jsonPath },
  encoding: "utf8",
  shell: true,
  maxBuffer: 128 * 1024 * 1024,
});
if (r.status !== 0) {
  console.error(r.stderr || r.stdout);
  process.exit(1);
}

const res = JSON.parse(readFileSync(jsonPath, "utf8"));
const pct = res.costPctPerSide;
const sessions = res.sessionDates.length;
const sum = (a) => a.reduce((x, y) => x + y, 0);

function card(key) {
  const s = res.strategies[key];
  const costsDaily = s.dailyTurnover.map((t) => t * pct);
  const netDaily = s.dailyGross.map((g, i) => g - costsDaily[i]);
  const rets = netDaily.map((n) => n / CAPITAL);
  const mean = sum(rets) / rets.length;
  const sd = Math.sqrt(sum(rets.map((x) => (x - mean) ** 2)) / rets.length);
  const t = s.trades;
  return {
    net: Math.round(sum(netDaily)),
    sharpe: sd > 0 ? Number(((mean / sd) * Math.sqrt(252)).toFixed(2)) : 0,
    winRate: t.n > 0 ? Number((t.wins / t.n).toFixed(3)) : 0,
    tradesPerSession: Number((t.n / sessions).toFixed(1)),
    costs: Math.round(sum(costsDaily) / sessions),
    profitFactor: t.sumLossNet > 0 ? Number((t.sumWinNet / t.sumLossNet).toFixed(2)) : 0,
    dailyPnl: netDaily.slice(-20).map((x) => Math.round(x)),
  };
}

const results = { orb: card("orb"), pairs: card("pairs"), vwap_reversion: card("vwap") };
const meta = {
  sessions,
  firstDay: res.sessionDates[0],
  lastDay: res.sessionDates[sessions - 1],
  costPctPerSide: pct,
  generatedAt: res.generatedAt.slice(0, 10),
};

const body = `// GENERATO da scripts/gen-backtest-card.mjs — non modificare a mano.
// Backtest storico reale (configurazione di produzione, costi di esecuzione dedotti), snapshot
// del ${meta.generatedAt}: non si aggiorna da solo, va rigenerato dopo ogni modifica di strategia.
// "costs" è il costo medio PER SEDUTA, "tradesPerSession" i round trip chiusi per seduta
// (pairs: coppie complete, non gambe), "dailyPnl" il netto delle ultime 20 sedute.

export const BACKTEST_META = ${JSON.stringify(meta, null, 2)};

export const BACKTEST_RESULTS = ${JSON.stringify(results, null, 2)};
`;
writeFileSync(path.resolve("src/data/backtestResults.ts"), body);
console.log(`Scritto src/data/backtestResults.ts (${sessions} sedute dal ${meta.firstDay} al ${meta.lastDay})`);
console.log(JSON.stringify(results, null, 2));

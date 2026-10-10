// Approfondimento dello stop del pairs (11/10/2026): dal giro scripts/pairs-signals-ab.mjs solo
// STOP_Z=4,5 migliora su entrambe le finestre (3,0 → 3,5 → 4,5 monotono). Qui: i vicini
// (4,0 / 5,0 / 6,0 — quest'ultimo ≈ "quasi mai stop") e il RISCHIO DI CODA, che il P&L medio
// nasconde: drawdown massimo e peggior giornata della serie giornaliera netta, base vs varianti.
// Uso: npx tsx scripts/pairs-stop-ab.mjs <cartella del giro precedente con c0-*.json e c6-*.json> [giorni] [ancora1] [ancora2]
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const prevDir = process.argv[2];
const days = Number(process.argv[3]) || 130;
const anchors = { recente: process.argv[4] || "2026-10-12", fuori_campione: process.argv[5] || "2026-05-11" };
const COST = 0.00023;
const CAP = 100_000;
const outDir = path.join(tmpdir(), `pairs-stop-${Date.now()}`);
mkdirSync(outDir, { recursive: true });

function run(name, windowKey, env) {
  const jsonPath = path.join(outDir, `${name}-${windowKey}.json`);
  return new Promise((resolve, reject) => {
    const p = spawn("npx", ["tsx", "scripts/backtest.ts", String(days), anchors[windowKey]], {
      env: { ...process.env, EXP_VWAP_TREND: "0", BACKTEST_JSON: jsonPath, ...env },
      shell: true,
    });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 ? resolve(jsonPath) : reject(new Error(`run fallito: ${err.slice(-300)}`))));
  });
}

function stats(file) {
  const j = JSON.parse(readFileSync(file, "utf8"));
  const s = j.strategies.pairs;
  const net = s.dailyGross.map((g, i) => g - COST * s.dailyTurnover[i]);
  let cum = 0, peak = 0, dd = 0, worst = 0;
  for (const v of net) {
    cum += v;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
    worst = Math.min(worst, v);
  }
  return { total: Math.round(cum), maxDD: Math.round(dd), maxDDpct: ((dd / CAP) * 100).toFixed(2), worstDay: Math.round(worst), trades: s.trades.n };
}

const variants = [
  ["stop4.0", { EXP_PAIRS_STOP_Z: "4.0" }],
  ["stop5.0", { EXP_PAIRS_STOP_Z: "5.0" }],
  ["stop6.0", { EXP_PAIRS_STOP_Z: "6.0" }],
];
const files = {
  "base 3.5": [path.join(prevDir, "c0-recente.json"), path.join(prevDir, "c0-fuori_campione.json")],
  "stop 3.0": [path.join(prevDir, "c5-recente.json"), path.join(prevDir, "c5-fuori_campione.json")],
  "stop 4.5": [path.join(prevDir, "c6-recente.json"), path.join(prevDir, "c6-fuori_campione.json")],
};
for (const [name, env] of variants) {
  console.log(`>>> ${name}...`);
  const [a, b] = await Promise.all([run(name, "recente", env), run(name, "fuori_campione", env)]);
  files[name.replace("stop", "stop ")] = [a, b];
}

console.log("\n=== PAIRS: stop, netto di costi e rischio di coda (recente | fuori campione) ===");
console.log("stop".padEnd(10), "netto".padStart(14), "maxDD $ (%)".padStart(26), "peggior giorno".padStart(18), "trade".padStart(10));
for (const key of ["stop 3.0", "base 3.5", "stop 4.0", "stop 4.5", "stop 5.0", "stop 6.0"]) {
  const [a, b] = files[key].map(stats);
  console.log(
    key.padEnd(10),
    `${a.total} | ${b.total}`.padStart(14),
    `${a.maxDD} (${a.maxDDpct}%) | ${b.maxDD} (${b.maxDDpct}%)`.padStart(26),
    `${a.worstDay} | ${b.worstDay}`.padStart(18),
    `${a.trades} | ${b.trades}`.padStart(10)
  );
}

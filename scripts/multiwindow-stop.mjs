// Approfondimento sullo stop del pairs sulle 9 finestre di scripts/multiwindow-ab.mjs (11/10/2026):
// 4,5 batte 3,5 in 8/9 finestre e 6,0 batte 4,5 in 6/9 — dove si ferma il miglioramento?
// Riusa cache intraday e JSON del giro precedente (cartella OUT), aggiunge 5,0 / 7,0 / 9,0
// (9,0 ≈ nessuno stop: |z| = 9 su un rapporto tra due titoli dello stesso settore non accade senza una
// rottura vera). Stampa netto per finestra, rischio di coda sul realizzato e numero di trade.
// Uso: npx tsx scripts/multiwindow-stop.mjs <OUT del giro precedente>
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

for (const l of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)="?(.*?)"?$/);
  if (m) process.env[m[1]] ??= m[2];
}
const prev = process.argv[2];
const COST = 0.00023;
const cacheDir = path.join(prev, "cache");
const anchors = ["2026-10-12", "2026-05-19", "2025-12-23", "2025-08-01", "2025-03-10", "2024-10-11", "2024-05-20", "2023-12-26", "2023-08-03"];
const extra = { "stop5.0": "5.0", "stop7.0": "7.0", "stop9.0": "9.0" };

function run(win, name, z) {
  const jsonPath = path.join(prev, `w${win}-${name}.json`);
  return new Promise((resolve, reject) => {
    const p = spawn("npx", ["tsx", "scripts/backtest.ts", "130", anchors[win]], {
      env: { ...process.env, EXP_VWAP_TREND: "0", BACKTEST_JSON: jsonPath, BACKTEST_CACHE_DIR: cacheDir, EXP_PAIRS_STOP_Z: z },
      shell: true,
    });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`w${win}/${name}: ${err.slice(-200)}`))));
  });
}
const tasks = [];
for (let w = 0; w < anchors.length; w++) for (const [n, z] of Object.entries(extra)) tasks.push(() => run(w, n, z));
let i = 0;
await Promise.all(
  Array.from({ length: 3 }, async () => {
    while (i < tasks.length) await tasks[i++]();
  })
);

const sum = (a) => a.reduce((x, y) => x + y, 0);
function load(w, cfg) {
  const j = JSON.parse(readFileSync(path.join(prev, `w${w}-${cfg}.json`), "utf8"));
  const s = j.strategies.pairs;
  return { net: s.dailyGross.map((g, k) => g - COST * s.dailyTurnover[k]), trades: s.trades.n };
}
const cfgs = ["stop3.5", "prod", "stop5.0", "stop6.0", "stop7.0", "stop9.0"];
const label = { "stop3.5": "3,5", prod: "4,5", "stop5.0": "5,0", "stop6.0": "6,0", "stop7.0": "7,0", "stop9.0": "9,0" };
console.log("PAIRS — netto per finestra (W0 = più recente)");
console.log("stop".padEnd(6), anchors.map((_, w) => `W${w}`.padStart(7)).join(""), "  TOTALE", " worst/day", "  maxDD%", " trade", " gg<-300");
for (const c of cfgs) {
  const per = anchors.map((_, w) => Math.round(sum(load(w, c).net)));
  const series = anchors.flatMap((_, w) => load(w, c).net);
  let cum = 0, peak = 0, dd = 0, worst = 0;
  for (const v of series) { cum += v; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); worst = Math.min(worst, v); }
  const trades = sum(anchors.map((_, w) => load(w, c).trades));
  console.log(
    label[c].padEnd(6),
    per.map((v) => String(v).padStart(7)).join(""),
    String(sum(per)).padStart(8),
    String(Math.round(worst)).padStart(10),
    ((dd / 1000)).toFixed(2).padStart(8),
    String(trades).padStart(6),
    String(series.filter((v) => v < -300).length).padStart(8)
  );
}

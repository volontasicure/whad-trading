// Escursione NON realizzata del pairs al variare dello stop, sulle 9 finestre (11/10/2026).
// Le serie giornaliere di P&L realizzato mostrano che uno stop largo non peggiora la coda REALIZZATA,
// ma non dicono quanto una coppia tenuta a lungo va sotto prima di rientrare — il limite principale
// dello stop a 6,0 con il conto reale al 100% pairs. Qui il valore di mercato delle coppie aperte:
//   - per coppia: peggior P&L non realizzato dall'ingresso (MAE) e P&L finale;
//   - per seduta: non realizzato a fine giornata e peggiore intragiornaliero;
//   - equity MTM = P&L netto realizzato cumulato + non realizzato aperto (lordo di costi), per
//     finestra (ogni finestra riparte da zero, quindi niente salti artificiali ai confini).
// Riusa la cache intraday del giro multiwindow-ab.mjs (cartella OUT).
// Uso: npx tsx scripts/pairs-mtm.mjs <OUT di multiwindow-ab.mjs>
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

for (const l of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)="?(.*?)"?$/);
  if (m) process.env[m[1]] ??= m[2];
}
const prev = process.argv[2];
const cacheDir = path.join(prev, "cache");
const outDir = path.join(tmpdir(), `pairs-mtm-${Date.now()}`);
mkdirSync(outDir, { recursive: true });
const COST = 0.00023;
const CAP = 100_000;
const anchors = ["2026-10-12", "2026-05-19", "2025-12-23", "2025-08-01", "2025-03-10", "2024-10-11", "2024-05-20", "2023-12-26", "2023-08-03"];
const stops = { "3,5": "3.5", "4,5": "4.5", "6,0": "6.0", "9,0": "9.0" };

function run(win, label, z) {
  const jsonPath = path.join(outDir, `w${win}-${label}.json`);
  return new Promise((resolve, reject) => {
    const p = spawn("npx", ["tsx", "scripts/backtest.ts", "130", anchors[win]], {
      env: { ...process.env, EXP_VWAP_TREND: "0", BACKTEST_JSON: jsonPath, BACKTEST_CACHE_DIR: cacheDir, EXP_PAIRS_STOP_Z: z },
      shell: true,
    });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`w${win}/${label}: ${err.slice(-200)}`))));
  });
}
const tasks = [];
for (let w = 0; w < anchors.length; w++) for (const [label, z] of Object.entries(stops)) tasks.push(() => run(w, label.replace(",", "_"), z));
let i = 0;
await Promise.all(
  Array.from({ length: 3 }, async () => {
    while (i < tasks.length) await tasks[i++]();
  })
);

const sum = (a) => a.reduce((x, y) => x + y, 0);
const pct = (x) => ((x / CAP) * 100).toFixed(2) + "%";
console.log("PAIRS — rischio NON realizzato (9 finestre, lab 100k$; MAE = peggior non realizzato di una coppia dall'ingresso)\n");
const rows = [];
for (const label of Object.keys(stops)) {
  const mdd = [];
  let worstIntraday = 0;
  let daysBelow1k = 0, daysBelow2k = 0, daysBelow3k = 0;
  let allMae = [];
  let realizedTotal = 0;
  for (let w = 0; w < anchors.length; w++) {
    const j = JSON.parse(readFileSync(path.join(outDir, `w${w}-${label.replace(",", "_")}.json`), "utf8"));
    const s = j.strategies.pairs;
    const net = s.dailyGross.map((g, k) => g - COST * s.dailyTurnover[k]);
    realizedTotal += sum(net);
    let cum = 0, peak = 0, dd = 0;
    for (let d = 0; d < net.length; d++) {
      cum += net[d];
      const eq = cum + s.mtm.dailyEndUnreal[d];
      peak = Math.max(peak, eq);
      dd = Math.max(dd, peak - eq);
    }
    mdd.push(dd);
    for (const u of s.mtm.dailyMinUnreal) {
      worstIntraday = Math.min(worstIntraday, u);
      if (u < -1000) daysBelow1k++;
      if (u < -2000) daysBelow2k++;
      if (u < -3000) daysBelow3k++;
    }
    allMae = allMae.concat(s.mtm.mae);
  }
  const mae = allMae.filter((m) => !m.open).sort((a, b) => a.mae - b.mae);
  const recovered = mae.filter((m) => m.mae < -1000 && m.pnl > 0).length;
  const deep = mae.filter((m) => m.mae < -1000).length;
  rows.push({ label, realizedTotal: Math.round(realizedTotal), worstMDD: Math.max(...mdd), meanMDD: sum(mdd) / mdd.length, worstIntraday, daysBelow1k, daysBelow2k, daysBelow3k, n: mae.length, deep, recovered, worst5: mae.slice(0, 5) });
}
console.log("stop  netto_real  maxDD_MTM(peggior finestra)  maxDD_MTM(media)  peggior_unreal_intraday   gg<-1k  <-2k  <-3k  trade  MAE<-1k (finiti in utile)");
for (const r of rows) {
  console.log(
    r.label.padEnd(5),
    String(r.realizedTotal).padStart(10),
    `${Math.round(r.worstMDD)} (${pct(r.worstMDD)})`.padStart(28),
    `${Math.round(r.meanMDD)} (${pct(r.meanMDD)})`.padStart(18),
    `${Math.round(r.worstIntraday)} (${pct(-r.worstIntraday)})`.padStart(24),
    String(r.daysBelow1k).padStart(8),
    String(r.daysBelow2k).padStart(6),
    String(r.daysBelow3k).padStart(6),
    String(r.n).padStart(6),
    `${r.deep} (${r.recovered})`.padStart(14)
  );
}
console.log("\nPeggiori 5 coppie per MAE (mae → P&L finale), per stop:");
for (const r of rows) console.log(`  stop ${r.label}: ` + r.worst5.map((m) => `${Math.round(m.mae)}→${Math.round(m.pnl)}`).join("  "));
console.log(`\nJSON in ${outDir}`);

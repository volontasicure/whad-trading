// Validazione su MOLTE finestre indipendenti (11/10/2026). Finora ogni decisione poggiava su 2
// finestre di ~100 sedute (18-26 trade nel pairs, differenze dentro il rumore) e la finestra
// "fuori campione" mancava di ~8 titoli (storico in DB solo dal giugno 2026). Dopo il backfill
// (1.028 sedute per titolo da settembre 2022, rettificate per split e spin-off) si possono
// rigiocare ~9 finestre contigue da ~100 sedute (≈ marzo 2023 → ottobre 2026), con 120 sedute di
// storico prima di ognuna, includendo il regime ribassista 2022-23.
//
// Configurazioni (tutte produzione = filtro trend VWAP spento, netto di costi):
//   prod       stop 4,5 · lookback 120 · VWAP 2,5%      (la configurazione di oggi)
//   stop3.5    stop pairs 3,5 (prima del cambio dell'11/10)
//   stop6.0    stop pairs 6,0 (≈ quasi nessuno stop: test del rischio di coda)
//   lb60/lb180 lookback z-score 60 / 180 sedute (la produzione prima del 10/10 usava ~62)
//   vwap1.2    soglia VWAP 1,2% (prima del cambio del 10/10)
// Per ogni finestra: prima "prod" (scarica e mette in cache l'intraday), poi le altre in parallelo.
// Uso: npx tsx scripts/multiwindow-ab.mjs [anchor-finale YYYY-MM-DD] [n-finestre]
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

for (const l of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)="?(.*?)"?$/);
  if (m) process.env[m[1]] ??= m[2];
}

const endAnchor = process.argv[2] || "2026-10-12";
const nWindows = Number(process.argv[3]) || 9;
const STEP = 100;
const COST = 0.00023;
const outDir = path.join(tmpdir(), `multiwin-${Date.now()}`);
const cacheDir = path.join(outDir, "cache");
mkdirSync(cacheDir, { recursive: true });
console.log(`OUT ${outDir}`);

const configs = {
  prod: {},
  "stop3.5": { EXP_PAIRS_STOP_Z: "3.5" },
  "stop6.0": { EXP_PAIRS_STOP_Z: "6.0" },
  lb60: { EXP_DAILY_LOOKBACK: "60" },
  lb180: { EXP_DAILY_LOOKBACK: "180" },
  "vwap1.2": { EXP_VWAP_EXTENSION_PCT: "1.2" },
};

// Calendario di borsa per ricavare le ancore a passi di STEP sedute.
const cal = await (
  await fetch(`https://paper-api.alpaca.markets/v2/calendar?start=2023-01-01&end=${endAnchor}`, {
    headers: { "APCA-API-KEY-ID": process.env.ALPACA_API_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET_KEY },
  })
).json();
const days = cal.map((c) => c.date).filter((d) => d < endAnchor);
const anchors = [endAnchor];
for (let k = 1; k < nWindows; k++) {
  const idx = days.length - STEP * k;
  if (idx < 0) break;
  anchors.push(days[idx]);
}
console.log(`Ancore (dalla più recente): ${anchors.join(" ")}`);

function run(win, cfgName) {
  const jsonPath = path.join(outDir, `w${win}-${cfgName}.json`);
  return new Promise((resolve, reject) => {
    const p = spawn("npx", ["tsx", "scripts/backtest.ts", "130", anchors[win]], {
      env: { ...process.env, EXP_VWAP_TREND: "0", BACKTEST_JSON: jsonPath, BACKTEST_CACHE_DIR: cacheDir, ...configs[cfgName] },
      shell: true,
    });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 ? resolve(jsonPath) : reject(new Error(`w${win}/${cfgName} fallito (${code}): ${err.slice(-300)}`))));
  });
}

async function pool(tasks, limit) {
  const results = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (i < tasks.length) {
        const my = i++;
        results[my] = await tasks[my]();
      }
    })
  );
  return results;
}

async function doWindow(win) {
  const t0 = Date.now();
  await run(win, "prod");
  const others = Object.keys(configs).filter((c) => c !== "prod");
  await pool(others.map((c) => () => run(win, c)), 2);
  console.log(`finestra ${win} (ancora ${anchors[win]}) completata in ${Math.round((Date.now() - t0) / 60000)} min`);
}

// Due finestre alla volta (il download intraday avviene solo nel primo run di ciascuna).
const winIdx = anchors.map((_, i) => i);
await pool(winIdx.map((w) => () => doWindow(w)), 2);

// --- Aggregazione ---
function load(win, cfg) {
  const j = JSON.parse(readFileSync(path.join(outDir, `w${win}-${cfg}.json`), "utf8"));
  const net = {};
  for (const k of ["orb", "vwap", "pairs"]) {
    const s = j.strategies[k];
    net[k] = s.dailyGross.map((g, i) => g - COST * s.dailyTurnover[i]);
  }
  return { net, dates: j.sessionDates, trades: { pairs: j.strategies.pairs.trades.n, vwap: j.strategies.vwap.trades.n, orb: j.strategies.orb.trades.n } };
}
const sum = (a) => a.reduce((x, y) => x + y, 0);

console.log("\n=== Finestre ===");
const data = {};
for (const cfg of Object.keys(configs)) data[cfg] = anchors.map((_, w) => load(w, cfg));
data.prod.forEach((d, w) => console.log(`  W${w}: ${d.dates.length} sedute ${d.dates[0]} → ${d.dates[d.dates.length - 1]}`));

function table(strategy, cfgs, title) {
  console.log(`\n=== ${title}: netto per finestra (W0 = più recente) ===`);
  console.log("config".padEnd(10), anchors.map((_, w) => `W${w}`.padStart(7)).join(""), "   TOTALE", "  finestre>prod");
  for (const cfg of cfgs) {
    const per = data[cfg].map((d) => Math.round(sum(d.net[strategy])));
    const base = data.prod.map((d) => Math.round(sum(d.net[strategy])));
    const better = per.filter((v, i) => v > base[i]).length;
    console.log(cfg.padEnd(10), per.map((v) => String(v).padStart(7)).join(""), String(sum(per)).padStart(10), cfg === "prod" ? "       —" : `   ${better}/${per.length}`);
  }
}
table("pairs", ["stop3.5", "prod", "stop6.0", "lb60", "lb180"], "PAIRS");
table("vwap", ["vwap1.2", "prod"], "VWAP");
table("orb", ["prod"], "ORB");

console.log("\n=== Trade totali (prod) ===");
console.log("  pairs:", sum(data.prod.map((d) => d.trades.pairs)), "| vwap:", sum(data.prod.map((d) => d.trades.vwap)), "| orb:", sum(data.prod.map((d) => d.trades.orb)));
for (const cfg of ["stop3.5", "stop6.0"]) console.log(`  pairs ${cfg}:`, sum(data[cfg].map((d) => d.trades.pairs)));

// --- Rischio di coda sul pairs: peggior giornata e drawdown massimo per configurazione ---
console.log("\n=== PAIRS: rischio di coda sul realizzato giornaliero (tutte le finestre concatenate) ===");
for (const cfg of ["stop3.5", "prod", "stop6.0"]) {
  const series = data[cfg].flatMap((d) => d.net.pairs);
  let cum = 0, peak = 0, dd = 0, worst = 0;
  for (const v of series) { cum += v; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); worst = Math.min(worst, v); }
  const losers = series.filter((v) => v < -300).length;
  console.log(`  ${cfg.padEnd(8)} totale ${Math.round(cum)} | maxDD ${Math.round(dd)} (${((dd / 100000) * 100).toFixed(2)}%) | peggior giorno ${Math.round(worst)} | giorni < -300$: ${losers}`);
}

// --- Gate sim su tutte le finestre (serie prod): ogni finestra, warm-up 20 ---
const avg = (a) => (a.length ? sum(a) / a.length : 0);
function mdd(series) { let c = 0, p = 0, d = 0; for (const v of series) { c += v; p = Math.max(p, c); d = Math.max(d, p - c); } return (d / 100000) * 100; }
const rules = {
  "nessun gate (1/3)": () => true,
  "SOLO pairs": (h, k) => k === "pairs",
  "gate5+DD (ieri)": (h) => avg(h.slice(-5)) >= 0 && mdd(h.slice(-20)) <= 5,
  "gate5+20+DD (oggi)": (h) => avg(h.slice(-5)) >= 0 && avg(h.slice(-20)) >= 0 && mdd(h.slice(-20)) <= 5,
};
console.log("\n=== Regole di ammissione, sedute dalla 21ª di ogni finestra (netto, lab 100k$) ===");
console.log("regola".padEnd(22), anchors.map((_, w) => `W${w}`.padStart(7)).join(""), "   TOTALE");
for (const [name, fn] of Object.entries(rules)) {
  const per = data.prod.map((d) => {
    let t = 0;
    for (let s = 20; s < d.dates.length; s++) {
      const adm = ["orb", "vwap", "pairs"].filter((k) => fn(d.net[k].slice(0, s), k));
      if (!adm.length) continue;
      for (const k of adm) t += d.net[k][s] / adm.length;
    }
    return Math.round(t);
  });
  console.log(name.padEnd(22), per.map((v) => String(v).padStart(7)).join(""), String(sum(per)).padStart(10));
}
writeFileSync(path.join(outDir, "done.txt"), "ok");
console.log(`\nDati in ${outDir}`);

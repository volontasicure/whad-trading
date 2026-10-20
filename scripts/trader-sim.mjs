// Banco di simulazione "trader review" (20/10/2026): rigioca N configurazioni del pairs sulle 9 finestre
// indipendenti (~890 sedute, 2023-2026, netto di costi) usando la cache su disco già scaricata — zero
// query al DB di produzione, ~40 s per finestra. Ogni configurazione è un nome più variabili EXP_*.
// Riprendibile: se il JSON di una finestra esiste già, non viene rigiocato.
// Uso: node scripts/trader-sim.mjs base shock3:EXP_PAIRS_SHOCK_K=3 mult2:EXP_PAIRS_CAPITAL_MULT=2
// Cartelle: TRADER_CACHE (default: cache delle 9 finestre in %TEMP%), TRADER_OUT (default %TEMP%/trader/runs).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

for (const l of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)="?(.*?)"?$/);
  if (m) process.env[m[1]] ??= m[2];
}

export const ANCHORS = ["2026-10-12", "2026-05-19", "2025-12-23", "2025-08-01", "2025-03-10", "2024-10-11", "2024-05-20", "2023-12-26", "2023-08-03"];
const tmp = tmpdir();
const cacheDir =
  process.env.TRADER_CACHE ||
  path.join(tmp, readdirSync(tmp).filter((d) => d.startsWith("multiwin-")).sort().pop(), "cache");
const outRoot = process.env.TRADER_OUT || path.join(tmp, "trader", "runs");
const concurrency = Number(process.env.TRADER_CONCURRENCY) || 3;

const CONT = process.argv.includes("--cont");
const specs = process.argv.slice(2).filter((a) => a !== "--cont").map((a) => {
  const [name, rest] = a.split(":");
  const env = {};
  for (const kv of (rest ?? "").split(",").filter(Boolean)) {
    const [k, v] = kv.split("=");
    env[k] = v;
  }
  return { name, env };
});
if (specs.length === 0) {
  console.error("Uso: node scripts/trader-sim.mjs nome[:KEY=V,KEY=V] ...");
  process.exit(1);
}

function run(spec, win) {
  const dir = path.join(outRoot, spec.name);
  mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, `w${win}.json`);
  if (existsSync(jsonPath)) return Promise.resolve("cache");
  return new Promise((resolve, reject) => {
    const p = spawn("npx", ["tsx", "scripts/backtest.ts", "130", ANCHORS[win]], {
      env: { ...process.env, EXP_VWAP_TREND: "0", BACKTEST_JSON: jsonPath, BACKTEST_CACHE_DIR: cacheDir, ...spec.env },
      shell: true,
    });
    let err = "";
    p.stdout.resume(); // senza questo, la run continua (892 righe di log) si blocca a pipe piena
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (c) => (c === 0 ? resolve("ok") : reject(new Error(`${spec.name} w${win}: ${err.slice(-300)}`))));
  });
}

// Modalità --cont: UNA run continua di 892 sedute (mar 2023 → ott 2026) con il libro aperto portato avanti, senza
// azzerare le posizioni ogni ~100 sedute: è la misura più fedele (nessuna troncatura del libro a fine finestra).
function runCont(spec) {
  const dir = path.join(outRoot, spec.name);
  mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, "cont.json");
  if (existsSync(jsonPath)) return Promise.resolve("cache");
  return new Promise((resolve, reject) => {
    const p = spawn("npx", ["tsx", "scripts/backtest.ts", "892", "2026-10-12"], {
      env: { ...process.env, EXP_VWAP_TREND: "0", BACKTEST_JSON: jsonPath, BACKTEST_CACHE_DIR: cacheDir, BACKTEST_CAL_FACTOR: "1.6", ...spec.env },
      shell: true,
    });
    let err = "";
    p.stdout.resume(); // senza questo, la run continua (892 righe di log) si blocca a pipe piena
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (c) => (c === 0 ? resolve("ok") : reject(new Error(spec.name + " cont: " + err.slice(-300)))));
  });
}
const tasks = [];
for (const spec of specs) {
  if (CONT) tasks.push(() => runCont(spec));
  else for (let w = 0; w < ANCHORS.length; w++) tasks.push(() => run(spec, w));
}
let i = 0;
let done = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (i < tasks.length) {
      const t = tasks[i++];
      await t();
      done++;
      if (done % 9 === 0 || done === tasks.length) console.log(`  ${done}/${tasks.length} finestre complete`);
    }
  })
);
console.log(`Fatto. Output in ${outRoot}`);

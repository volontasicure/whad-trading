// A/B per generare PIÙ SEGNALI nel pairs (11/10/2026): il pairs è l'unica strategia con edge
// consistente ma fa ~0,3 trade a seduta e impiega ~30% del proprio budget — il collo di bottiglia
// è la rarità dei segnali, non la capacità. Mai testati finora: ENTRY_Z/EXIT_Z/STOP_Z (default
// 2,0/0,3/3,5), il pool di coppie candidate (solo le 10 più correlate non sovrapposte: metà dei
// 40 titoli non è mai in nessuna coppia) e l'universo (40 → 80 titoli, server/universeExtra.ts).
// Tutte le configurazioni: produzione (EXP_VWAP_TREND=0), lookback 120, due finestre indipendenti
// in parallelo, P&L al netto dei costi (server/costs.ts). Il JSON di ogni run è salvato per
// simulazioni successive (es. regole di ammissione a partire dalle serie giornaliere).
// Uso: npx tsx scripts/pairs-signals-ab.mjs [giorni] [ancora1] [ancora2]
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const days = Number(process.argv[2]) || 130;
const anchors = { recente: process.argv[3] || "2026-10-12", fuori_campione: process.argv[4] || "2026-05-11" };
const outDir = path.join(tmpdir(), `pairs-ab-${Date.now()}`);
mkdirSync(outDir, { recursive: true });
console.log(`JSON per run in ${outDir}`);

const E = (o) => o;
const configs = [
  { name: "base (2.0/0.3/3.5, pool 10)", env: E({}) },
  { name: "entry 1.5", env: E({ EXP_PAIRS_ENTRY_Z: "1.5" }) },
  { name: "entry 1.75", env: E({ EXP_PAIRS_ENTRY_Z: "1.75" }) },
  { name: "entry 2.5", env: E({ EXP_PAIRS_ENTRY_Z: "2.5" }) },
  { name: "exit 0.6", env: E({ EXP_PAIRS_EXIT_Z: "0.6" }) },
  { name: "stop 3.0", env: E({ EXP_PAIRS_STOP_Z: "3.0" }) },
  { name: "stop 4.5", env: E({ EXP_PAIRS_STOP_Z: "4.5" }) },
  { name: "pool 20 (40 titoli)", env: E({ EXP_PAIRS_CANDIDATES: "20" }) },
  { name: "universo 80, pool 10", env: E({ EXP_EXTRA_UNIVERSE: "1" }) },
  { name: "universo 80, pool 20", env: E({ EXP_EXTRA_UNIVERSE: "1", EXP_PAIRS_CANDIDATES: "20" }) },
  { name: "universo 80, pool 40", env: E({ EXP_EXTRA_UNIVERSE: "1", EXP_PAIRS_CANDIDATES: "40" }) },
];

const COST = 0.00023;

function run(cfgIdx, windowKey, env) {
  const jsonPath = path.join(outDir, `c${cfgIdx}-${windowKey}.json`);
  return new Promise((resolve, reject) => {
    const p = spawn("npx", ["tsx", "scripts/backtest.ts", String(days), anchors[windowKey]], {
      env: { ...process.env, EXP_VWAP_TREND: "0", BACKTEST_JSON: jsonPath, ...env },
      shell: true,
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`run fallito (${code}): ${(err || out).slice(-500)}`))));
  });
}

function parsePairs(out) {
  const m = out.match(/^pairs: (\d+) entrate, (\d+) uscite, P&L realizzato = (-?\d+)/m);
  const t = out.match(/^turnover pairs: (\d+)/m);
  const miss = out.match(/Titoli extra senza barre giornaliere[^\n]*/);
  return m && t ? { entries: Number(m[1]), exits: Number(m[2]), gross: Number(m[3]), turnover: Number(t[1]), missing: miss?.[0] } : null;
}

const results = [];
for (let i = 0; i < configs.length; i++) {
  const c = configs[i];
  console.log(`>>> [${i + 1}/${configs.length}] ${c.name}...`);
  try {
    const [a, b] = await Promise.all([run(i, "recente", c.env), run(i, "fuori_campione", c.env)]);
    const r = { name: c.name, recente: parsePairs(a), oos: parsePairs(b) };
    results.push(r);
    console.log(`    recente=${JSON.stringify(r.recente)}\n    oos=${JSON.stringify(r.oos)}`);
  } catch (e) {
    console.log(`    ERRORE: ${e.message}`);
    results.push({ name: c.name, error: e.message });
  }
}

const net = (x) => (x ? Math.round(x.gross - COST * x.turnover) : null);
console.log("\n=== PAIRS al netto dei costi (0,023%/lato) — recente | fuori campione ===");
console.log("configurazione".padEnd(30), "netto".padStart(16), "lordo".padStart(14), "entrate".padStart(12), "uscite".padStart(10));
for (const r of results) {
  if (r.error) {
    console.log(r.name.padEnd(30), "ERRORE");
    continue;
  }
  console.log(
    r.name.padEnd(30),
    `${net(r.recente)} | ${net(r.oos)}`.padStart(16),
    `${r.recente.gross} | ${r.oos.gross}`.padStart(14),
    `${r.recente.entries} | ${r.oos.entries}`.padStart(12),
    `${r.recente.exits} | ${r.oos.exits}`.padStart(10)
  );
}
writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(results, null, 2));
console.log(`\nRiepilogo salvato in ${path.join(outDir, "summary.json")}`);

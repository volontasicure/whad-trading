// A/B su EXP_PAIRS_MAX_HOLD_DAYS: chiusura forzata di una coppia dopo N sedute aperte,
// indipendentemente dallo z-score. Ipotesi nata dalla scoperta dell'1/10/2026 (JPM/BAC e
// KO/PEP mai rientrate per settimane, z-score persistentemente sopra soglia senza mai toccare
// né il target 0,3 né lo stop 3,5). Testato su due finestre indipendenti come da prassi.
// Uso: npx tsx scripts/pairs-maxhold-ab.mjs [giorni] [ancora1] [ancora2]
import { spawnSync } from "node:child_process";

const days = Number(process.argv[2]) || 130;
const anchor1 = process.argv[3] || new Date().toISOString().slice(0, 10);
const anchor2 = process.argv[4] || "2026-05-11";

function runBacktest(env, anchor) {
  const r = spawnSync("npx", ["tsx", "scripts/backtest.ts", String(days), anchor], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    shell: true,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`backtest fallito: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function parsePairs(out) {
  const m = out.match(/^pairs: (\d+) entrate, (\d+) uscite, P&L realizzato = (-?\d+), motivi uscita: (.*)$/m);
  const first = out.match(/Rigioco (\d+) giorni di mercato: (\d{4}-\d{2}-\d{2})/);
  return {
    entries: m ? Number(m[1]) : null,
    exits: m ? Number(m[2]) : null,
    pnl: m ? Number(m[3]) : null,
    reasons: m ? m[4] : null,
    daysUsed: first ? Number(first[1]) : null,
    firstDay: first?.[2],
  };
}

const holdValues = [0, 3, 5, 7];
const results = { recent: {}, oos: {} };

for (const hd of holdValues) {
  const env = hd > 0 ? { EXP_PAIRS_MAX_HOLD_DAYS: String(hd) } : {};
  console.log(`\n>>> EXP_PAIRS_MAX_HOLD_DAYS=${hd || "(baseline, nessun limite)"} — finestra recente (ancora ${anchor1})...`);
  const outRecent = runBacktest(env, anchor1);
  results.recent[hd] = parsePairs(outRecent);
  console.log(`    pairs: ${JSON.stringify(results.recent[hd])}`);

  console.log(`>>> EXP_PAIRS_MAX_HOLD_DAYS=${hd || "(baseline, nessun limite)"} — finestra fuori campione (ancora ${anchor2})...`);
  const outOos = runBacktest(env, anchor2);
  results.oos[hd] = parsePairs(outOos);
  console.log(`    pairs: ${JSON.stringify(results.oos[hd])}`);
}

console.log("\n\n=== RIEPILOGO: P&L pairs per valore di EXP_PAIRS_MAX_HOLD_DAYS ===");
console.log(`Finestra recente: ${results.recent[0].daysUsed} sedute dal ${results.recent[0].firstDay} al ${anchor1}`);
console.log(`Finestra fuori campione: ${results.oos[0].daysUsed} sedute dal ${results.oos[0].firstDay} al ${anchor2}`);
console.log("\nhold_days | recente (P&L, entrate/uscite) | fuori_campione (P&L, entrate/uscite)");
for (const hd of holdValues) {
  const r = results.recent[hd];
  const o = results.oos[hd];
  console.log(
    `${String(hd).padStart(9)} | ${String(r.pnl).padStart(6)} (${r.entries}e/${r.exits}u)`.padEnd(45) +
      ` | ${String(o.pnl).padStart(6)} (${o.entries}e/${o.exits}u)`
  );
}
console.log("\nmotivi uscita per valore:");
for (const hd of holdValues) {
  console.log(`  ${hd}: recente={${results.recent[hd].reasons}} fuori_campione={${results.oos[hd].reasons}}`);
}

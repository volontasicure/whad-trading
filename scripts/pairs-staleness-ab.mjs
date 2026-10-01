// A/B su EXP_PAIRS_STALENESS_DAYS: esclude dai NUOVI ingressi una coppia il cui |z| non si è
// mai avvicinato al rientro (<= EXP_PAIRS_STALENESS_PROXIMITY) in nessuna delle ultime N sedute
// — le posizioni già aperte non sono toccate. Più chirurgico di EXP_PAIRS_MAX_HOLD_DAYS (scartata
// l'1/10/2026): non forza la chiusura delle coppie sane. Testato su due finestre indipendenti.
// Uso: npx tsx scripts/pairs-staleness-ab.mjs [giorni] [ancora1] [ancora2]
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

const staleValues = [0, 3, 5, 7];
const results = { recent: {}, oos: {} };

for (const sd of staleValues) {
  const env = sd > 0 ? { EXP_PAIRS_STALENESS_DAYS: String(sd) } : {};
  console.log(`\n>>> EXP_PAIRS_STALENESS_DAYS=${sd || "(baseline, nessun filtro)"} — finestra recente (ancora ${anchor1})...`);
  const outRecent = runBacktest(env, anchor1);
  results.recent[sd] = parsePairs(outRecent);
  console.log(`    pairs: ${JSON.stringify(results.recent[sd])}`);

  console.log(`>>> EXP_PAIRS_STALENESS_DAYS=${sd || "(baseline, nessun filtro)"} — finestra fuori campione (ancora ${anchor2})...`);
  const outOos = runBacktest(env, anchor2);
  results.oos[sd] = parsePairs(outOos);
  console.log(`    pairs: ${JSON.stringify(results.oos[sd])}`);
}

console.log("\n\n=== RIEPILOGO: P&L pairs per valore di EXP_PAIRS_STALENESS_DAYS (prossimità=1.0) ===");
console.log(`Finestra recente: ${results.recent[0].daysUsed} sedute dal ${results.recent[0].firstDay} al ${anchor1}`);
console.log(`Finestra fuori campione: ${results.oos[0].daysUsed} sedute dal ${results.oos[0].firstDay} al ${anchor2}`);
console.log("\nstale_days | recente (P&L, entrate/uscite) | fuori_campione (P&L, entrate/uscite)");
for (const sd of staleValues) {
  const r = results.recent[sd];
  const o = results.oos[sd];
  console.log(
    `${String(sd).padStart(10)} | ${String(r.pnl).padStart(6)} (${r.entries}e/${r.exits}u)`.padEnd(46) +
      ` | ${String(o.pnl).padStart(6)} (${o.entries}e/${o.exits}u)`
  );
}
console.log("\nmotivi uscita per valore:");
for (const sd of staleValues) {
  console.log(`  ${sd}: recente={${results.recent[sd].reasons}} fuori_campione={${results.oos[sd].reasons}}`);
}

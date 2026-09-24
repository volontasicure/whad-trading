// A/B delle varianti ORB dopo la seduta whipsaw del 24/9/2026 (13 ingressi, 12 stop, 1 target,
// -1.154 nel lab, record negativo — TXN e GE, i range più stretti in % del prezzo, rientrati
// 3-4 volte ciascuno sullo stesso livello). Uso, a mercato CHIUSO:
//   node scripts/orb-ab.mjs [giorni=39]
// Due finestre (recente / fuori campione), stessa disciplina di scripts/vwap-ab.mjs e
// scripts/selection-rule-refresh.mjs. Una variante si adotta solo se batte la produzione
// (nessuna variante attiva) su ENTRAMBE.
import { spawnSync } from "node:child_process";

const days = Number(process.argv[2]) || 39;

const VARIANTS = [
  { name: "produzione (nessuna variante)", env: {} },
  { name: "range minimo 0,6%", env: { EXP_ORB_MIN_RANGE_PCT: "0.6" } },
  { name: "range minimo 0,8%", env: { EXP_ORB_MIN_RANGE_PCT: "0.8" } },
  { name: "conferma 2 barre", env: { EXP_ORB_CONFIRM_BARS: "2" } },
  { name: "max 2 ingressi/simbolo", env: { EXP_ORB_MAX_ENTRIES_PER_SYMBOL: "2" } },
  { name: "range minimo 0,6% + max 2/simbolo", env: { EXP_ORB_MIN_RANGE_PCT: "0.6", EXP_ORB_MAX_ENTRIES_PER_SYMBOL: "2" } },
];

function runBacktest(beforeDate, env) {
  const r = spawnSync("npx", ["tsx", "scripts/backtest.ts", String(days), beforeDate], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`backtest fallito (${beforeDate}): ${r.stderr || r.stdout}`);
  const out = r.stdout;
  const first = out.match(/Rigioco \d+ giorni di mercato: (\d{4}-\d{2}-\d{2})/);
  const orb = out.match(/^orb: (\d+) entrate, (\d+) uscite, P&L realizzato = (-?\d+), motivi uscita: (.*)$/m);
  if (!orb) throw new Error(`riepilogo ORB non trovato (${beforeDate}):\n${out.slice(-1500)}`);
  return { firstDay: first?.[1], entries: Number(orb[1]), pnl: Number(orb[3]), reasons: orb[4] };
}

const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

const results = [];
let oosBefore = null;
for (const v of VARIANTS) {
  console.log(`\n>>> ${v.name}: finestra recente...`);
  const recent = runBacktest(tomorrow, v.env);
  oosBefore ??= recent.firstDay;
  console.log(`>>> ${v.name}: fuori campione (prima di ${oosBefore})...`);
  const oos = runBacktest(oosBefore, v.env);
  results.push({ v, recent, oos });
}

const base = results[0];
console.log(`\n=== ORB: P&L lab realizzato, ${days} sedute per finestra (recente dal ${oosBefore}) ===`);
console.log("variante".padEnd(34), "recente".padStart(9), "fuori camp.".padStart(12), "ingressi (rec/oos)".padStart(20), "  verdetto vs produzione");
for (const { v, recent, oos } of results) {
  const better = recent.pnl > base.recent.pnl && oos.pnl > base.oos.pnl;
  const worse = recent.pnl < base.recent.pnl && oos.pnl < base.oos.pnl;
  const verdict = v === base.v ? "-" : better ? "MIGLIORA su entrambe" : worse ? "peggiora su entrambe" : "misto: non adottare";
  console.log(v.name.padEnd(34), String(recent.pnl).padStart(9), String(oos.pnl).padStart(12), `${recent.entries}/${oos.entries}`.padStart(20), " ", verdict);
}
console.log("\nMotivi di uscita (recente):");
for (const { v, recent } of results) console.log(`  ${v.name}: ${recent.reasons}`);

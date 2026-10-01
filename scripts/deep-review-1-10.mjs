// Backtest approfondito del 1/10/2026: tutta la storia intraday disponibile (~6 mesi, non più
// le finestre di 39 giorni usate finora) con i parametri ATTUALMENTE in produzione (nessun
// EXP_* diverso da EOD_MODE), per rispondere a due domande con molti più dati:
// 1. Come si comportano le tre strategie, con la calibrazione di oggi, fin dall'inizio?
// 2. Ha senso chiudere sempre tutte le posizioni ogni giorno? (confronto "current" produzione
//    vs "always" chiudi tutto sempre vs "never" nessuna rete di sicurezza EOD).
// Uso: npx tsx scripts/deep-review-1-10.mjs [giorni]
import { spawnSync } from "node:child_process";

const days = Number(process.argv[2]) || 130;
// Oggi (1/10) è un giorno di mercato ancora in corso/con barre incomplete al momento del test
// — ancorare a oggi stesso, non domani, per escluderlo dalla finestra. Secondo argomento
// opzionale: ancora una finestra PRIMA di quella data invece che su oggi, per una seconda
// finestra indipendente (fuori campione).
const anchor = process.argv[3] || new Date().toISOString().slice(0, 10);

function runBacktest(env) {
  const r = spawnSync("npx", ["tsx", "scripts/backtest.ts", String(days), anchor], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    shell: true,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`backtest fallito: ${r.stderr || r.stdout}`);
  return r.stdout;
}

console.log(`Finestra: ${days} sedute fino al ${anchor} (parametri di produzione attuali)\n`);

console.log(">>> Modalità EOD 'current' (produzione) — anche baseline per l'analisi dettagliata...");
const outCurrent = runBacktest({ EXP_EOD_MODE: "current" });

console.log(">>> Modalità EOD 'always' (chiudi tutto sempre, anche i pairs)...");
const outAlways = runBacktest({ EXP_EOD_MODE: "always" });

console.log(">>> Modalità EOD 'never' (nessuna rete di sicurezza EOD)...");
const outNever = runBacktest({ EXP_EOD_MODE: "never" });

function parseSummary(out) {
  const totals = {};
  for (const m of out.matchAll(/^(orb|vwap|pairs): (\d+) entrate, (\d+) uscite, P&L realizzato = (-?\d+), motivi uscita: (.*)$/gm)) {
    totals[m[1]] = { entries: Number(m[2]), exits: Number(m[3]), pnl: Number(m[4]), reasons: m[5] };
  }
  const first = out.match(/Rigioco (\d+) giorni di mercato: (\d{4}-\d{2}-\d{2})/);
  const anomalies = out.match(/Anomalie rilevate: (\d+)/);
  const rulesStart = out.indexOf("=== Regole di scelta giornaliera");
  const rulesSection = rulesStart >= 0 ? out.slice(rulesStart, out.indexOf("\nAnomalie rilevate")) : "";
  return { totals, daysUsed: first ? Number(first[1]) : null, firstDay: first?.[2], anomalyCount: anomalies ? Number(anomalies[1]) : null, rulesSection };
}

const current = parseSummary(outCurrent);
const always = parseSummary(outAlways);
const never = parseSummary(outNever);

console.log(`\n=== 1. Baseline produzione attuale, ${current.daysUsed} sedute (dal ${current.firstDay} al ${anchor}) ===\n`);
for (const strat of ["orb", "vwap", "pairs"]) {
  const t = current.totals[strat];
  if (!t) continue;
  console.log(`${strat}: ${t.entries} entrate, ${t.exits} uscite, P&L = ${t.pnl}`);
  console.log(`  motivi uscita: ${t.reasons}`);
}
const totalNet = Object.values(current.totals).reduce((s, t) => s + t.pnl, 0);
console.log(`\nTotale combinato (3 lab da 100.000$ ciascuno): ${totalNet} (${((totalNet / 300000) * 100).toFixed(2)}% sul capitale totale dei 3 lab)`);
console.log(current.rulesSection);
console.log(`Anomalie rilevate nel run: ${current.anomalyCount}`);

console.log(`\n=== 2. "Chiudere sempre tutto" — confronto sulle stesse ${current.daysUsed} sedute ===\n`);
console.log("modalità".padEnd(10), "orb".padStart(9), "vwap".padStart(9), "pairs".padStart(9), "totale".padStart(10));
for (const [label, r] of [["current", current], ["always", always], ["never", never]]) {
  const o = r.totals.orb?.pnl ?? 0;
  const v = r.totals.vwap?.pnl ?? 0;
  const p = r.totals.pairs?.pnl ?? 0;
  console.log(label.padEnd(10), String(o).padStart(9), String(v).padStart(9), String(p).padStart(9), String(o + v + p).padStart(10));
}

console.log("\nMotivi di uscita pairs, per modalità:");
for (const [label, r] of [["current", current], ["always", always], ["never", never]]) {
  console.log(`  ${label}: ${r.totals.pairs?.reasons ?? "n/d"}`);
}

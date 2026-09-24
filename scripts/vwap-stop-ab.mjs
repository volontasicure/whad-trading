// A/B sullo stop del VWAP, dopo l'analisi del 24/9/2026 sullo storico completo: il bucket
// stop_loss (29 trade su tutta la storia, netto -2.674, media -92/trade) è di gran lunga il
// più grande fattore di perdita del VWAP, mentre max_hold (43 trade, +692) è lievemente
// positivo — segno che il segnale d'ingresso ha un margine, tagliato spesso dallo stop attuale
// (0,6%) prima di potersi esprimere. Uso, a mercato CHIUSO: node scripts/vwap-stop-ab.mjs [giorni=39]
import { spawnSync } from "node:child_process";

const days = Number(process.argv[2]) || 39;

const VARIANTS = [
  { name: "produzione (0,6%)", env: {} },
  { name: "stop 0,8%", env: { EXP_VWAP_STOP_PCT: "0.8" } },
  { name: "stop 1,0%", env: { EXP_VWAP_STOP_PCT: "1.0" } },
  { name: "stop 1,2%", env: { EXP_VWAP_STOP_PCT: "1.2" } },
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
  const vwap = out.match(/^vwap: (\d+) entrate, (\d+) uscite, P&L realizzato = (-?\d+), motivi uscita: (.*)$/m);
  if (!vwap) throw new Error(`riepilogo VWAP non trovato (${beforeDate}):\n${out.slice(-1500)}`);
  return { firstDay: first?.[1], entries: Number(vwap[1]), pnl: Number(vwap[3]), reasons: vwap[4] };
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
console.log(`\n=== VWAP stop: P&L lab realizzato, ${days} sedute per finestra (recente dal ${oosBefore}) ===`);
console.log("variante".padEnd(24), "recente".padStart(9), "fuori camp.".padStart(12), "ingressi (rec/oos)".padStart(20), "  verdetto vs produzione");
for (const { v, recent, oos } of results) {
  const better = recent.pnl > base.recent.pnl && oos.pnl > base.oos.pnl;
  const worse = recent.pnl < base.recent.pnl && oos.pnl < base.oos.pnl;
  const verdict = v === base.v ? "-" : better ? "MIGLIORA su entrambe" : worse ? "peggiora su entrambe" : "misto: non adottare";
  console.log(v.name.padEnd(24), String(recent.pnl).padStart(9), String(oos.pnl).padStart(12), `${recent.entries}/${oos.entries}`.padStart(20), " ", verdict);
}
console.log("\nMotivi di uscita (recente):");
for (const { v, recent } of results) console.log(`  ${v.name}: ${recent.reasons}`);

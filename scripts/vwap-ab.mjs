// A/B delle varianti VWAP dopo la seduta del 21/9/2026 (META shortata 6 volte, 5 uscite in perdita).
// Uso, a mercato CHIUSO (legge molte barre da Alpaca, non va lanciato mentre gira il tick):
//   node scripts/vwap-ab.mjs [giorni=39]
// Due finestre: "recente" (ultimi N giorni, oggi incluso) e "fuori campione" (gli N giorni prima
// dell'inizio di quella recente). Una variante si adotta solo se batte la produzione (filtro trend
// spento, nessun limite) su ENTRAMBE — stessa regola dei punti 9-11 di CLAUDE.md.
import { spawnSync } from "node:child_process";

const days = Number(process.argv[2]) || 39;

const VARIANTS = [
  { name: "produzione (trend spento)", env: { EXP_VWAP_TREND: "0" } },
  { name: "trend acceso", env: { EXP_VWAP_TREND: "1" } },
  { name: "cooldown dopo stop", env: { EXP_VWAP_TREND: "0", EXP_VWAP_COOLDOWN_STOP: "1" } },
  { name: "max 2 ingressi/simbolo", env: { EXP_VWAP_TREND: "0", EXP_VWAP_MAX_ENTRIES_PER_SYMBOL: "2" } },
  { name: "trend + cooldown", env: { EXP_VWAP_TREND: "1", EXP_VWAP_COOLDOWN_STOP: "1" } },
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

// finestra recente: il giorno dopo oggi come estremo escluso, così include la seduta di oggi
const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

const results = [];
let oosBefore = null;
for (const v of VARIANTS) {
  console.log(`\n>>> ${v.name}: finestra recente...`);
  const recent = runBacktest(tomorrow, v.env);
  // il confine fuori campione è fissato dalla prima variante, uguale per tutte
  oosBefore ??= recent.firstDay;
  console.log(`>>> ${v.name}: fuori campione (prima di ${oosBefore})...`);
  const oos = runBacktest(oosBefore, v.env);
  results.push({ v, recent, oos });
}

const base = results[0];
console.log(`\n=== VWAP: P&L lab realizzato, ${days} sedute per finestra (recente dal ${oosBefore}) ===`);
console.log("variante".padEnd(28), "recente".padStart(9), "fuori camp.".padStart(12), "ingressi (rec/oos)".padStart(20), "  verdetto vs produzione");
for (const { v, recent, oos } of results) {
  const better = recent.pnl > base.recent.pnl && oos.pnl > base.oos.pnl;
  const worse = recent.pnl < base.recent.pnl && oos.pnl < base.oos.pnl;
  const verdict = v === base.v ? "-" : better ? "MIGLIORA su entrambe" : worse ? "peggiora su entrambe" : "misto: non adottare";
  console.log(v.name.padEnd(28), String(recent.pnl).padStart(9), String(oos.pnl).padStart(12), `${recent.entries}/${oos.entries}`.padStart(20), " ", verdict);
}
console.log("\nMotivi di uscita (recente):");
for (const { v, recent } of results) console.log(`  ${v.name}: ${recent.reasons}`);

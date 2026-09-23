// Aggiorna il confronto "regole di scelta giornaliera" del checkpoint 18/9 con i giorni reali
// aggiunti da allora (produzione: nessuna variante EXP_ attiva). Due finestre, stesso metodo
// di scripts/vwap-ab.mjs. Uso, a mercato CHIUSO: node scripts/selection-rule-refresh.mjs [giorni=39]
import { spawnSync } from "node:child_process";

const days = Number(process.argv[2]) || 39;

function runBacktest(beforeDate) {
  const r = spawnSync("npx", ["tsx", "scripts/backtest.ts", String(days), beforeDate], {
    encoding: "utf8",
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`backtest fallito (${beforeDate}): ${r.stderr || r.stdout}`);
  const out = r.stdout;
  const first = out.match(/Rigioco \d+ giorni di mercato: (\d{4}-\d{2}-\d{2})/);
  const rulesStart = out.indexOf("=== Regole di scelta giornaliera");
  const rulesSection = rulesStart >= 0 ? out.slice(rulesStart, out.indexOf("\nAnomalie rilevate")) : "(sezione non trovata)\n" + out.slice(-1000);
  const totals = [...out.matchAll(/^(orb|vwap|pairs): (\d+) entrate, (\d+) uscite, P&L realizzato = (-?\d+)/gm)];
  return { firstDay: first?.[1], rulesSection, totals };
}

const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

console.log(`>>> Finestra recente (${days} sedute fino a oggi)...`);
const recent = runBacktest(tomorrow);
console.log(`>>> Finestra fuori campione (${days} sedute prima del ${recent.firstDay})...`);
const oos = runBacktest(recent.firstDay);

console.log(`\n=== Totali per strategia, finestra RECENTE (dal ${recent.firstDay}) ===`);
for (const t of recent.totals) console.log(` ${t[1]}: ${t[2]} entrate, ${t[3]} uscite, P&L = ${t[4]}`);
console.log(recent.rulesSection);

console.log(`\n=== Totali per strategia, finestra FUORI CAMPIONE (prima del ${recent.firstDay}) ===`);
for (const t of oos.totals) console.log(` ${t[1]}: ${t[2]} entrate, ${t[3]} uscite, P&L = ${t[4]}`);
console.log(oos.rulesSection);

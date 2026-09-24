// A/B su quattro parametri non ancora testati, dopo i sei tentativi falliti del 24/9/2026
// (range minimo/conferma barre/tetto ingressi su ORB, stop su VWAP — tutti su assi già
// esauriti). Qui si cambiano assi diversi: ampiezza del range e soglia volume per ORB,
// durata massima in posizione e soglia di estensione per VWAP. Uso, a mercato CHIUSO:
//   node scripts/other-params-ab.mjs [giorni=39]
import { spawnSync } from "node:child_process";

const days = Number(process.argv[2]) || 39;

const VARIANTS = [
  { name: "produzione", strategy: "-", env: {} },
  { name: "ORB range 30 min (vs 15)", strategy: "orb", env: { EXP_ORB_RANGE_MINUTES: "30" } },
  { name: "ORB range 20 min (vs 15)", strategy: "orb", env: { EXP_ORB_RANGE_MINUTES: "20" } },
  { name: "ORB volume 2,5x (vs 1,8x)", strategy: "orb", env: { EXP_ORB_VOLUME_MULT: "2.5" } },
  { name: "ORB volume 1,4x (vs 1,8x)", strategy: "orb", env: { EXP_ORB_VOLUME_MULT: "1.4" } },
  { name: "VWAP max hold 90 min (vs 45)", strategy: "vwap", env: { EXP_VWAP_MAX_HOLD_MIN: "90" } },
  { name: "VWAP max hold 60 min (vs 45)", strategy: "vwap", env: { EXP_VWAP_MAX_HOLD_MIN: "60" } },
  { name: "VWAP estensione 1,6% (vs 1,2%)", strategy: "vwap", env: { EXP_VWAP_EXTENSION_PCT: "1.6" } },
  { name: "VWAP estensione 1,8% (vs 1,2%)", strategy: "vwap", env: { EXP_VWAP_EXTENSION_PCT: "1.8" } },
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
  const vwap = out.match(/^vwap: (\d+) entrate, (\d+) uscite, P&L realizzato = (-?\d+), motivi uscita: (.*)$/m);
  return {
    firstDay: first?.[1],
    orb: orb ? { entries: Number(orb[1]), pnl: Number(orb[3]), reasons: orb[4] } : null,
    vwap: vwap ? { entries: Number(vwap[1]), pnl: Number(vwap[3]), reasons: vwap[4] } : null,
  };
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

const baseline = results[0];
console.log(`\n=== Altri parametri: P&L lab realizzato, ${days} sedute per finestra (recente dal ${oosBefore}) ===`);
console.log("variante".padEnd(32), "recente".padStart(9), "fuori camp.".padStart(12), "ingressi (rec/oos)".padStart(20), "  verdetto vs produzione");
for (const { v, recent, oos } of results) {
  if (v.strategy === "-") {
    console.log(v.name.padEnd(32), "-".padStart(9), "-".padStart(12), "-".padStart(20), "  (baseline)");
    continue;
  }
  const r = recent[v.strategy];
  const o = oos[v.strategy];
  const br = baseline.recent[v.strategy];
  const bo = baseline.oos[v.strategy];
  const better = r.pnl > br.pnl && o.pnl > bo.pnl;
  const worse = r.pnl < br.pnl && o.pnl < bo.pnl;
  const verdict = better ? "MIGLIORA su entrambe" : worse ? "peggiora su entrambe" : "misto: non adottare";
  console.log(v.name.padEnd(32), String(r.pnl).padStart(9), String(o.pnl).padStart(12), `${r.entries}/${o.entries}`.padStart(20), " ", verdict);
}
console.log(`\nBaseline produzione — ORB: recente ${baseline.recent.orb.pnl} / oos ${baseline.oos.orb.pnl}; VWAP: recente ${baseline.recent.vwap.pnl} / oos ${baseline.oos.vwap.pnl}`);
console.log("\nMotivi di uscita (recente):");
for (const { v, recent } of results) {
  if (v.strategy === "-") continue;
  console.log(`  ${v.name}: ${JSON.stringify(recent[v.strategy].reasons)}`);
}

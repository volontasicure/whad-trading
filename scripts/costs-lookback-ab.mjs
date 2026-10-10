// Due misure, un solo giro di backtest per combinazione (10/10/2026):
// 1) lookback del z-score/correlazione dei pairs: EXP_DAILY_LOOKBACK in {60, 90, 120, 180} —
//    la produzione usa ~62 sedute (fetchDailyBars(90)), le validazioni storiche usavano 120.
// 2) costi di esecuzione: il backtest riporta il nozionale scambiato per strategia (turnover),
//    quindi il netto per qualunque costo per lato si calcola a posteriori (netto = lordo −
//    pct × turnover), senza rilanciare. Costi calibrati sul divario reale-vs-lab del VWAP dal
//    26/9: 0,060% (lab) − 0,014% (reale) ≈ 0,046% per round trip ≈ 0,023% per lato.
// Uso: npx tsx scripts/costs-lookback-ab.mjs [giorni] [ancora1] [ancora2]
import { spawnSync } from "node:child_process";

const days = Number(process.argv[2]) || 130;
const anchor1 = process.argv[3] || "2026-10-09";
const anchor2 = process.argv[4] || "2026-05-11";
const lookbacks = [60, 90, 120, 180];
const COST_PER_SIDE_PCT = [0, 0.01, 0.023, 0.04];

function run(lookback, anchor) {
  const r = spawnSync("npx", ["tsx", "scripts/backtest.ts", String(days), anchor], {
    env: { ...process.env, EXP_DAILY_LOOKBACK: String(lookback) },
    encoding: "utf8",
    shell: true,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`backtest fallito: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function parse(out) {
  const res = {};
  for (const m of out.matchAll(/^(orb|vwap|pairs): (\d+) entrate, (\d+) uscite, P&L realizzato = (-?\d+)/gm)) {
    res[m[1]] = { entries: Number(m[2]), exits: Number(m[3]), gross: Number(m[4]) };
  }
  for (const m of out.matchAll(/^turnover (orb|vwap|pairs): (\d+)/gm)) res[m[1]].turnover = Number(m[2]);
  const first = out.match(/Rigioco (\d+) giorni di mercato: (\d{4}-\d{2}-\d{2})/);
  res.meta = { days: first ? Number(first[1]) : null, firstDay: first?.[2] };
  return res;
}

const results = {};
for (const lb of lookbacks) {
  for (const [label, anchor] of [["recente", anchor1], ["fuori_campione", anchor2]]) {
    console.log(`>>> lookback=${lb} finestra=${label} (ancora ${anchor})...`);
    results[`${lb}|${label}`] = parse(run(lb, anchor));
  }
}

console.log("\n=== P&L LORDO per strategia e lookback (recente / fuori campione) ===");
for (const strat of ["orb", "vwap", "pairs"]) {
  console.log(`\n${strat}:`);
  for (const lb of lookbacks) {
    const a = results[`${lb}|recente`][strat];
    const b = results[`${lb}|fuori_campione`][strat];
    console.log(`  lookback ${String(lb).padStart(3)}: ${String(a.gross).padStart(6)} (${a.entries}e) / ${String(b.gross).padStart(6)} (${b.entries}e)`);
  }
}

console.log("\n=== P&L NETTO a diversi costi per lato (lookback 120 = validazioni storiche) ===");
for (const strat of ["orb", "vwap", "pairs"]) {
  const a = results["120|recente"][strat];
  const b = results["120|fuori_campione"][strat];
  console.log(`\n${strat} (turnover ${Math.round(a.turnover / 1000)}k / ${Math.round(b.turnover / 1000)}k):`);
  for (const pct of COST_PER_SIDE_PCT) {
    const na = Math.round(a.gross - (pct / 100) * a.turnover);
    const nb = Math.round(b.gross - (pct / 100) * b.turnover);
    console.log(`  costo ${pct.toFixed(3)}%/lato: ${String(na).padStart(6)} / ${String(nb).padStart(6)}`);
  }
}

console.log("\n=== P&L NETTO a 0,023%/lato per lookback ===");
for (const strat of ["orb", "vwap", "pairs"]) {
  console.log(`\n${strat}:`);
  for (const lb of lookbacks) {
    const a = results[`${lb}|recente`][strat];
    const b = results[`${lb}|fuori_campione`][strat];
    const na = Math.round(a.gross - 0.00023 * a.turnover);
    const nb = Math.round(b.gross - 0.00023 * b.turnover);
    console.log(`  lookback ${String(lb).padStart(3)}: ${String(na).padStart(6)} / ${String(nb).padStart(6)}`);
  }
}
console.log(`\nFinestre: recente ${results["120|recente"].meta.days} sedute dal ${results["120|recente"].meta.firstDay}; fuori campione ${results["120|fuori_campione"].meta.days} dal ${results["120|fuori_campione"].meta.firstDay}`);

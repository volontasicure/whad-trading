// Collaudo di server/trendEtf.ts (LAB D, trend ETF): casi sintetici + RIPRODUZIONE storica con la stessa contabilità
// del lab (righe lab_positions, costo 0,023% per lato sul nozionale intero di ogni riga chiusa, banda di ribilanciamento)
// confrontata con la variante S4 di scripts/trend-test.mjs. Richiede la cache ETF creata da trend-test.mjs.
// Uso: npx tsx scripts/test-trend-etf.ts
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CAPITAL, MIN_HISTORY, REBALANCE_BAND, TREND_SYMBOLS, computeSignals, computeTargetWeights, decideRebalance, isRebalanceDue, type TrendPosition } from "../server/trendEtf.js";
import { LAB_COST_PCT_PER_SIDE } from "../server/costs.js";

let n = 0;
function test(name: string, fn: () => void) {
  fn();
  n++;
  console.log(`  ok  ${name}`);
}

// ---- casi sintetici ----
const flat = (v: number, len = 300) => Array.from({ length: len }, () => v);
const trend = (start: number, step: number, len = 300) => Array.from({ length: len }, (_, i) => start + step * i + (i % 2 ? 0.1 : -0.1));

test("segnale: sopra la SMA200 → long, sotto → fuori; storico corto → ETF ignorato", () => {
  const sig = computeSignals({ SPY: trend(100, 0.2), TLT: trend(200, -0.2), GLD: flat(100, 100) });
  assert.equal(sig.SPY.above, true);
  assert.equal(sig.TLT.above, false);
  assert.equal(sig.GLD, undefined, `meno di ${MIN_HISTORY} chiusure`);
});

test("pesi: solo ETF sopra la media, somma ≤ 1, nessun peso negativo", () => {
  const plan = computeTargetWeights({ SPY: trend(100, 0.2), QQQ: trend(100, 0.3), TLT: trend(200, -0.2) });
  assert.equal(plan.weights.TLT, 0);
  assert.ok(plan.weights.SPY > 0 && plan.weights.QQQ > 0);
  assert.ok(plan.gross <= 1 + 1e-9);
  assert.ok(Object.values(plan.weights).every((w) => w >= 0));
});

test("nessun ETF sopra la media → tutto in liquidità", () => {
  const plan = computeTargetWeights({ SPY: trend(200, -0.2), QQQ: trend(200, -0.3) });
  assert.equal(plan.gross, 0);
});

test("ribilanciamento: ETF nuovo → apre; invariato entro la banda → non tocca; oltre la banda → chiude e riapre; segnale perso → chiude", () => {
  const plan = { weights: Object.fromEntries(TREND_SYMBOLS.map((s) => [s, 0])), signals: {}, portfolioVol: 0.1, gross: 0.5 } as ReturnType<typeof computeTargetWeights>;
  plan.weights.SPY = 0.3; // 30.000$ a 100 → 300 azioni
  const open: TrendPosition[] = [
    { id: 1, symbol: "SPY", qty: 290, entryPrice: 95 }, // entro il 20%: resta
    { id: 2, symbol: "TLT", qty: 100, entryPrice: 90 }, // senza peso: esce
    { id: 3, symbol: "GLD", qty: 10, entryPrice: 100 }, // senza peso: esce
  ];
  const prices = Object.fromEntries(TREND_SYMBOLS.map((s) => [s, 100]));
  let d = decideRebalance(plan, CAPITAL, prices, open);
  assert.deepEqual(d.closes.map((c) => c.symbol).sort(), ["GLD", "TLT"]);
  assert.equal(d.opens.length, 0, "SPY 290 vs 300: dentro la banda");
  assert.equal(d.closes.find((c) => c.symbol === "TLT")!.realizedPnl, 1000);
  d = decideRebalance(plan, CAPITAL, prices, [{ id: 1, symbol: "SPY", qty: 200, entryPrice: 95 }]);
  assert.equal(d.closes.length, 1);
  assert.deepEqual(d.opens, [{ symbol: "SPY", qty: 300, price: 100 }], "200 vs 300: oltre la banda, riapre alla quantità target");
  d = decideRebalance(plan, CAPITAL, prices, []);
  assert.deepEqual(d.opens, [{ symbol: "SPY", qty: 300, price: 100 }]);
});

test("ribilanciamento mensile: dovuto alla prima esecuzione e al cambio di mese, non dentro lo stesso mese", () => {
  assert.equal(isRebalanceDue(null, "2026-10-21"), true);
  assert.equal(isRebalanceDue("2026-10", "2026-10-30"), false);
  assert.equal(isRebalanceDue("2026-10", "2026-11-02"), true);
});

// ---- riproduzione storica ----
const cache = path.join(tmpdir(), "trader", "etf_daily.json");
const resultsFile = path.join(tmpdir(), "trader", "trend_results.json");
if (!existsSync(cache) || !existsSync(resultsFile)) {
  console.log("\n(cache ETF o risultati S4 assenti: eseguire prima `node scripts/trend-test.mjs` per la riproduzione storica)");
  console.log(`\n${n} test passati`);
  process.exit(0);
}
const bars: Record<string, { t: string; o: number; c: number }[]> = JSON.parse(readFileSync(cache, "utf8"));
const sets = TREND_SYMBOLS.map((s) => new Set(bars[s].map((b) => b.t.slice(0, 10))));
const dates = [...sets[0]].filter((d) => sets.every((s) => s.has(d))).sort();
const idx = Object.fromEntries(TREND_SYMBOLS.map((s) => [s, Object.fromEntries(bars[s].map((b) => [b.t.slice(0, 10), b]))]));
const O = Object.fromEntries(TREND_SYMBOLS.map((s) => [s, dates.map((d) => idx[s][d].o)]));
const C = Object.fromEntries(TREND_SYMBOLS.map((s) => [s, dates.map((d) => idx[s][d].c)]));
const START = 260;

interface Row {
  id: number;
  symbol: string;
  qty: number;
  entry: number;
  exit?: number;
}
const rows: Row[] = [];
let nextId = 1;
let netRealized = 0;
let trades = 0;
const eq: number[] = [];
const costOf = (r: Row) => LAB_COST_PCT_PER_SIDE * r.qty * (r.entry + (r.exit ?? 0));
for (let t = START; t < dates.length; t++) {
  // come il backtest S4: si ribilancia alla prima seduta di ogni mese
  const firstOfMonth = t > 0 && dates[t].slice(0, 7) !== dates[t - 1].slice(0, 7);
  if (firstOfMonth) {
    const closes = Object.fromEntries(TREND_SYMBOLS.map((s) => [s, C[s].slice(0, t)])); // fino a t-1
    const prices = Object.fromEntries(TREND_SYMBOLS.map((s) => [s, O[s][t]]));
    const open = rows.filter((r) => r.exit == null);
    const unreal = open.reduce((a, r) => a + r.qty * (prices[r.symbol] - r.entry), 0);
    const equity = CAPITAL + netRealized + unreal;
    const d = decideRebalance(
      computeTargetWeights(closes),
      equity,
      prices,
      open.map((r) => ({ id: r.id, symbol: r.symbol, qty: r.qty, entryPrice: r.entry }))
    );
    for (const c of d.closes) {
      const r = rows.find((x) => x.id === c.id)!;
      r.exit = c.exitPrice;
      netRealized += r.qty * (r.exit - r.entry) - costOf(r);
      trades++;
    }
    for (const o of d.opens) rows.push({ id: nextId++, symbol: o.symbol, qty: o.qty, entry: o.price });
  }
  const open = rows.filter((r) => r.exit == null);
  eq.push(CAPITAL + netRealized + open.reduce((a, r) => a + r.qty * (C[r.symbol][t] - r.entry), 0));
}
const s4: number[] = JSON.parse(readFileSync(resultsFile, "utf8")).results.find((r: { name: string }) => r.name.startsWith("S4 SMA200")).eq;
const years = eq.length / 252;
const cagr = (e: number[]) => Math.pow(e.at(-1)! / e[0], 1 / years) - 1;
const maxdd = (e: number[]) => {
  let p = -Infinity;
  let d = 0;
  for (const v of e) {
    p = Math.max(p, v);
    d = Math.max(d, (p - v) / p);
  }
  return d;
};
console.log(`\nRiproduzione storica ${dates[START]} → ${dates.at(-1)} (${years.toFixed(1)} anni), ${trades} righe chiuse, banda ±${REBALANCE_BAND * 100}%`);
console.log(`  lab D (righe + banda): rendimento ${(cagr(eq) * 100).toFixed(2)}%/anno, drawdown ${(maxdd(eq) * 100).toFixed(1)}%, equity finale ${Math.round(eq.at(-1)!)}`);
console.log(`  backtest S4          : rendimento ${(cagr(s4) * 100).toFixed(2)}%/anno, drawdown ${(maxdd(s4) * 100).toFixed(1)}%, equity finale ${Math.round(s4.at(-1)!)}`);
test("il lab D riproduce la variante S4 del backtest (rendimento ±0,6 punti/anno, drawdown ±2 punti)", () => {
  assert.ok(Math.abs(cagr(eq) - cagr(s4)) < 0.006, `scarto rendimento ${((cagr(eq) - cagr(s4)) * 100).toFixed(2)} punti`);
  assert.ok(Math.abs(maxdd(eq) - maxdd(s4)) < 0.02, `scarto drawdown ${((maxdd(eq) - maxdd(s4)) * 100).toFixed(1)} punti`);
});
console.log(`\n${n} test passati`);

// Collaudo di server/trendEtf.ts (LAB D trend ETF, LAB E rotazione ETF): casi sintetici + RIPRODUZIONE storica con la
// stessa contabilità del lab (righe lab_positions, costo 0,023% per lato sul nozionale intero di ogni riga chiusa, banda
// di ribilanciamento) confrontata con le serie di scripts/redesign-test.ts ai parametri CORE_PARAMS.
// Richiede la cache ETF (%TEMP%/trader/etf_daily_v2.json) e il riferimento core_ref.json scritto da redesign-test.ts.
// Uso: npx tsx scripts/test-trend-etf.ts
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ALL_SYMBOLS,
  CAPITAL,
  CASH_SYMBOL,
  CORE_PARAMS,
  MIN_HISTORY,
  REBALANCE_BAND,
  computeRotationWeights,
  computeSignals,
  computeTargetWeights,
  decideRebalance,
  isRebalanceDue,
  type TargetPlan,
  type TrendPosition,
} from "../server/trendEtf.js";
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
const bills = (len = 300) => Array.from({ length: len }, (_, i) => 100 * (1 + 0.0001 * i)); // ~2,5%/anno

test("segnale: sopra la media → long, sotto → fuori; storico corto → ETF ignorato", () => {
  const sig = computeSignals({ SPY: trend(100, 0.2), TLT: trend(200, -0.2), GLD: flat(100, 100) });
  assert.equal(sig.SPY.above, true);
  assert.equal(sig.TLT.above, false);
  assert.equal(sig.GLD, undefined, `meno di ${MIN_HISTORY} chiusure`);
});

test("trend: solo ETF sopra la media, rischio ≤ 1, il resto in BIL, nessun peso negativo", () => {
  const plan = computeTargetWeights({ SPY: trend(100, 0.2), QQQ: trend(100, 0.3), TLT: trend(200, -0.2), BIL: bills() });
  assert.equal(plan.weights.TLT, 0);
  assert.ok(plan.weights.SPY > 0 && plan.weights.QQQ > 0);
  assert.ok(plan.gross <= 1 + 1e-9);
  assert.ok(Math.abs(plan.gross + plan.weights.BIL - 1) < 1e-9, "rischio + BIL = 100%");
  assert.ok(Object.values(plan.weights).every((w) => w >= 0));
});

test("trend: nessun ETF sopra la media → tutto in BIL; senza storico di BIL → liquidità", () => {
  let plan = computeTargetWeights({ SPY: trend(200, -0.2), QQQ: trend(200, -0.3), BIL: bills() });
  assert.equal(plan.gross, 0);
  assert.equal(plan.weights.BIL, 1);
  plan = computeTargetWeights({ SPY: trend(200, -0.2) });
  assert.equal(plan.weights.BIL, 0);
});

test("rotazione: i topK migliori che battono i T-bill, peso 1/topK, il resto in BIL", () => {
  const k = CORE_PARAMS.rotation.topK;
  const closes: Record<string, number[]> = { BIL: bills() };
  // 6 ETF in salita con pendenze crescenti, 2 in discesa
  ["SPY", "QQQ", "IWM", "EFA", "EEM", "GLD"].forEach((s, i) => (closes[s] = trend(100, 0.05 * (i + 1))));
  closes.TLT = trend(200, -0.2);
  closes.IEF = trend(200, -0.1);
  const plan = computeRotationWeights(closes);
  const chosen = Object.entries(plan.weights).filter(([s, w]) => s !== CASH_SYMBOL && w > 0).map(([s]) => s);
  assert.equal(chosen.length, k);
  assert.ok(!chosen.includes("SPY"), "il più debole dei 6 in salita resta fuori");
  assert.ok(!chosen.includes("TLT") && !chosen.includes("IEF"));
  assert.ok(Math.abs(plan.weights.BIL - (1 - k / k)) < 1e-9);
  assert.equal(plan.scores!.GLD.rank, 1);
});

test("rotazione: solo 2 ETF battono i T-bill → 2 slot, il resto (1 − 2/topK) in BIL; senza BIL nulla", () => {
  const k = CORE_PARAMS.rotation.topK;
  const closes: Record<string, number[]> = { BIL: bills(), SPY: trend(100, 0.2), QQQ: trend(100, 0.3), TLT: trend(200, -0.2), IEF: trend(200, -0.1), GLD: flat(100) };
  let plan = computeRotationWeights(closes);
  assert.equal(plan.gross, 2 / k);
  assert.ok(Math.abs(plan.weights.BIL - (1 - 2 / k)) < 1e-9);
  delete closes.BIL;
  plan = computeRotationWeights(closes);
  assert.equal(plan.gross, 0, "senza il riferimento dei T-bill non si compra nulla");
});

test("ribilanciamento: ETF nuovo → apre; entro la banda → non tocca; oltre → chiude e riapre; senza peso → chiude; BIL incluso", () => {
  const plan = { weights: Object.fromEntries(ALL_SYMBOLS.map((s) => [s, 0])), signals: {}, portfolioVol: 0.1, gross: 0.3 } as TargetPlan;
  plan.weights.SPY = 0.3; // 30.000$ a 100 → 300 azioni
  plan.weights.BIL = 0.7; // 70.000$ a 100 → 700
  const open: TrendPosition[] = [
    { id: 1, symbol: "SPY", qty: 290, entryPrice: 95 }, // entro il 20%: resta
    { id: 2, symbol: "TLT", qty: 100, entryPrice: 90 }, // senza peso: esce
    { id: 3, symbol: "GLD", qty: 10, entryPrice: 100 }, // senza peso: esce
  ];
  const prices = Object.fromEntries(ALL_SYMBOLS.map((s) => [s, 100]));
  let d = decideRebalance(plan, CAPITAL, prices, open);
  assert.deepEqual(d.closes.map((c) => c.symbol).sort(), ["GLD", "TLT"]);
  assert.deepEqual(d.opens, [{ symbol: "BIL", qty: 700, price: 100 }], "SPY 290 vs 300: dentro la banda; BIL si apre");
  assert.equal(d.closes.find((c) => c.symbol === "TLT")!.realizedPnl, 1000);
  d = decideRebalance(plan, CAPITAL, prices, [{ id: 1, symbol: "SPY", qty: 200, entryPrice: 95 }, { id: 4, symbol: "BIL", qty: 700, entryPrice: 100 }]);
  assert.equal(d.closes.length, 1);
  assert.deepEqual(d.opens, [{ symbol: "SPY", qty: 300, price: 100 }], "200 vs 300: oltre la banda, riapre alla quantità target");
});

test("ribilanciamento dovuto: prima esecuzione, cambio di mese, cambio di versione dei parametri; non dentro lo stesso mese", () => {
  assert.equal(isRebalanceDue(null, "2026-10-21"), true);
  assert.equal(isRebalanceDue("2026-10", "2026-10-30"), false);
  assert.equal(isRebalanceDue("2026-10", "2026-10-30", CORE_PARAMS.version), false);
  assert.equal(isRebalanceDue("2026-10", "2026-10-30", null), true, "stato senza versione (LAB D prima del 22/10)");
  assert.equal(isRebalanceDue("2026-10", "2026-10-30", "wf-2025"), true);
  assert.equal(isRebalanceDue("2026-10", "2026-11-02", CORE_PARAMS.version), true);
});

// ---- riproduzione storica ----
const cache = path.join(tmpdir(), "trader", "etf_daily_v2.json");
const refFile = path.join(tmpdir(), "trader", "core_ref.json");
if (!existsSync(cache) || !existsSync(refFile)) {
  console.log("\n(cache ETF o core_ref.json assenti: eseguire prima `npx tsx scripts/redesign-test.ts` per la riproduzione storica)");
  console.log(`\n${n} test passati`);
  process.exit(0);
}
const bars: Record<string, { t: string; o: number; c: number }[]> = JSON.parse(readFileSync(cache, "utf8"));
const ref: { dates: string[]; trend: number[]; rotation: number[] } = JSON.parse(readFileSync(refFile, "utf8"));
const dates = bars.SPY.map((b) => b.t);
const idx = Object.fromEntries(ALL_SYMBOLS.map((s) => [s, Object.fromEntries(bars[s].map((b) => [b.t, b]))]));
const O = Object.fromEntries(ALL_SYMBOLS.map((s) => [s, dates.map((d) => idx[s][d].o)]));
const C = Object.fromEntries(ALL_SYMBOLS.map((s) => [s, dates.map((d) => idx[s][d].c)]));
const START = dates.indexOf(ref.dates[0]);

function replay(planOf: (closes: Record<string, number[]>) => TargetPlan) {
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
    const due = t === START || dates[t].slice(0, 7) !== dates[t - 1].slice(0, 7);
    if (due) {
      const closes = Object.fromEntries(ALL_SYMBOLS.map((s) => [s, C[s].slice(Math.max(0, t - 300), t)])); // fino a t-1, ~come fetchCloses
      const prices = Object.fromEntries(ALL_SYMBOLS.map((s) => [s, O[s][t]]));
      const open = rows.filter((r) => r.exit == null);
      const equity = CAPITAL + netRealized + open.reduce((a, r) => a + r.qty * (prices[r.symbol] - r.entry), 0);
      const d = decideRebalance(planOf(closes), equity, prices, open.map((r) => ({ id: r.id, symbol: r.symbol, qty: r.qty, entryPrice: r.entry })));
      for (const c of d.closes) {
        const r = rows.find((x) => x.id === c.id)!;
        r.exit = c.exitPrice;
        netRealized += r.qty * (r.exit - r.entry) - costOf(r);
        trades++;
      }
      for (const o of d.opens) rows.push({ id: nextId++, symbol: o.symbol, qty: o.qty, entry: o.price });
    }
    eq.push(CAPITAL + netRealized + rows.filter((r) => r.exit == null).reduce((a, r) => a + r.qty * (C[r.symbol][t] - r.entry), 0));
  }
  return { eq, trades };
}
const toEquity = (rets: number[]) => {
  let v = CAPITAL;
  return rets.map((r) => (v *= 1 + r));
};
const years = (dates.length - START) / 252;
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
console.log(`\nRiproduzione storica ${dates[START]} → ${dates.at(-1)} (${years.toFixed(1)} anni), banda ±${REBALANCE_BAND * 100}%, parametri ${CORE_PARAMS.version}`);
for (const [name, planOf, refRets] of [
  ["LAB D trend", (c: Record<string, number[]>) => computeTargetWeights(c), ref.trend],
  ["LAB E rotazione", (c: Record<string, number[]>) => computeRotationWeights(c), ref.rotation],
] as const) {
  const lab = replay(planOf);
  const bt = toEquity(refRets);
  console.log(`  ${name.padEnd(16)} lab (righe + banda): ${(cagr(lab.eq) * 100).toFixed(2)}%/anno, DD ${(maxdd(lab.eq) * 100).toFixed(1)}%, ${lab.trades} righe chiuse | backtest: ${(cagr(bt) * 100).toFixed(2)}%/anno, DD ${(maxdd(bt) * 100).toFixed(1)}%`);
  test(`${name}: il lab riproduce il backtest (rendimento ±0,6 punti/anno, drawdown ±2 punti)`, () => {
    assert.ok(Math.abs(cagr(lab.eq) - cagr(bt)) < 0.006, `scarto rendimento ${((cagr(lab.eq) - cagr(bt)) * 100).toFixed(2)} punti`);
    assert.ok(Math.abs(maxdd(lab.eq) - maxdd(bt)) < 0.02, `scarto drawdown ${((maxdd(lab.eq) - maxdd(bt)) * 100).toFixed(1)} punti`);
  });
}
console.log(`\n${n} test passati`);

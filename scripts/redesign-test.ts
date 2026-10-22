// Ridisegno integrale delle strategie (22/10/2026): confronto su 10 anni (luglio 2016 → ottobre 2026) tra il sistema
// com'era, il sistema com'è oggi e un portafoglio multi-motore, con calibrazione WALK-FORWARD: i parametri di ogni anno
// si scelgono solo sui dati degli anni precedenti e si applicano all'anno dopo (nessun parametro vede il futuro).
//
// Fonti (tutte su disco, ZERO query al database di produzione):
//   - ORB, VWAP, PAIRS: due run CONTINUE di scripts/backtest.ts (codice di produzione, barre a 5 minuti SIP scaricate
//     con scripts/prefetch-sip-history.ts) dal 2016 al 2026: `base` (produzione, stop a tempo 40 sedute) e `nohold`
//     (EXP_PAIRS_MAX_HOLD_DAYS=0, il pairs prima del 21/10). Misura: mark-to-market (realizzato + variazione del non
//     realizzato), netto di costi 0,023%/lato e di un prestito titoli dello 0,5%/anno sulle gambe corte del pairs.
//   - ETF: barre giornaliere SIP rettificate (%TEMP%/trader/etf_daily_v2.json, 24 ETF).
//
// Motori ETF:
//   TF  trend su 12 ETF (= LAB D): long se sopra la media a N sedute, pesi inversi alla volatilità, target di vol.
//   RM  momentum relativo (rotazione) sugli stessi 12 ETF: i K migliori per rendimento a L mesi, solo se battono i
//       T-bill (BIL); peso uguale, slot vuoti in BIL.
//   Liquidità non investita in BIL (T-bill 1-3 mesi) invece che a rendimento zero.
// Uso: npx tsx scripts/redesign-test.ts [cartellaRun=%TEMP%/trader/runs16]
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const COST = 0.00023;
const BORROW = 0.005 / 252;
const CAP = 100_000;
const T = path.join(tmpdir(), "trader");
const RUNS = process.argv[2] ?? path.join(T, "runs16");

type Bar = { t: string; o: number; c: number };
const etfBars: Record<string, Bar[]> = JSON.parse(readFileSync(path.join(T, "etf_daily_v2.json"), "utf8"));
const dates = etfBars.SPY.map((b) => b.t);
const N = dates.length;
const dIdx = new Map(dates.map((d, i) => [d, i]));
const E: Record<string, { o: number[]; c: number[] }> = {};
for (const s of Object.keys(etfBars)) {
  const o = new Array(N).fill(NaN), c = new Array(N).fill(NaN);
  for (const b of etfBars[s]) {
    const i = dIdx.get(b.t);
    if (i != null) (o[i] = b.o), (c[i] = b.c);
  }
  E[s] = { o, c };
}

// ---------------------------------------------------------------- statistiche
const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
const sdev = (x: number[]) => {
  const m = mean(x);
  return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / x.length);
};
const sharpe = (r: number[]) => (sdev(r) > 0 ? (mean(r) / sdev(r)) * Math.sqrt(252) : 0);
// Rendimento giornaliero dei T-bill (BIL): Sharpe e t si calcolano sul rendimento IN ECCESSO, altrimenti tenere la cassa
// in BIL gonfierebbe lo Sharpe del portafoglio nuovo rispetto a quello attuale (cassa a rendimento zero).
let RF: number[] = [];
const excess = (r: number[], from: number) => r.map((x, i) => x - (RF[from + i] ?? 0));
function cov(x: number[], y: number[]) {
  const mx = mean(x), my = mean(y);
  let s = 0;
  for (let i = 0; i < x.length; i++) s += (x[i] - mx) * (y[i] - my);
  return s / x.length;
}
function metrics(r: number[], ds: string[], from: number) {
  const ex = excess(r, from);
  let eq = 1, peak = 1, dd = 0, under = 0, maxUnder = 0;
  const eqs: number[] = [];
  for (const x of r) {
    eq *= 1 + x;
    if (eq >= peak) (peak = eq), (under = 0);
    else maxUnder = Math.max(maxUnder, ++under);
    dd = Math.max(dd, 1 - eq / peak);
    eqs.push(eq);
  }
  const byYear: Record<string, number> = {};
  ds.forEach((d, i) => (byYear[d.slice(0, 4)] = (byYear[d.slice(0, 4)] ?? 1) * (1 + r[i])));
  let neg12 = 0, n12 = 0;
  for (let i = 252; i < eqs.length; i += 21) {
    n12++;
    if (eqs[i] / eqs[i - 252] < 1) neg12++;
  }
  return {
    cagr: Math.pow(eq, 252 / r.length) - 1,
    vol: sdev(r) * Math.sqrt(252),
    sharpe: sharpe(ex),
    tstat: (mean(ex) / sdev(ex)) * Math.sqrt(r.length),
    dd,
    maxUnderMonths: maxUnder / 21,
    neg12: n12 ? neg12 / n12 : 0,
    worstDay: Math.min(...r),
    years: Object.fromEntries(Object.entries(byYear).map(([y, v]) => [y, v - 1])),
  };
}

// ---------------------------------------------------------------- run intraday di produzione (ORB / VWAP / PAIRS)
interface RunSeries { orb: number[]; vwap: number[]; pairs: number[]; openPairs: number[]; trades: any[]; first: number }
function loadRun(name: string, costMult = 1): RunSeries {
  const j = JSON.parse(readFileSync(path.join(RUNS, name, "cont.json"), "utf8"));
  const out: RunSeries = { orb: new Array(N).fill(0), vwap: new Array(N).fill(0), pairs: new Array(N).fill(0), openPairs: new Array(N).fill(0), trades: j.strategies.pairs.tradeLog, first: N };
  const un: number[] = j.strategies.pairs.mtm.dailyEndUnreal;
  const op: number[] = j.strategies.pairs.exposure.dailyOpenPairs;
  j.sessionDates.forEach((d: string, i: number) => {
    const t = dIdx.get(d);
    if (t == null) throw new Error(`seduta ${d} assente dal calendario ETF`);
    out.first = Math.min(out.first, t);
    for (const k of ["orb", "vwap"] as const) {
      const s = j.strategies[k];
      out[k][t] = (s.dailyGross[i] - s.dailyTurnover[i] * COST * costMult) / CAP;
    }
    const p = j.strategies.pairs;
    // ~5k$ di gamba corta per coppia aperta (5k per gamba su 100k, server/pairsTrading.ts)
    out.pairs[t] = (p.dailyGross[i] - p.dailyTurnover[i] * COST * costMult + (un[i] - (i ? un[i - 1] : 0)) - op[i] * 5000 * BORROW) / CAP;
    out.openPairs[t] = op[i];
  });
  return out;
}

// ---------------------------------------------------------------- motore ETF (pesi mensili, esecuzione all'apertura)
const U12 = ["SPY", "QQQ", "IWM", "EFA", "EEM", "VNQ", "TLT", "IEF", "LQD", "GLD", "DBC", "UUP"];
const firstOfMonth = (t: number) => t > 0 && dates[t].slice(0, 7) !== dates[t - 1].slice(0, 7);
function dailyRets(sym: string, from: number, to: number) {
  const out: number[] = [];
  for (let k = from; k < to; k++) out.push(E[sym].c[k] / E[sym].c[k - 1] - 1);
  return out;
}
/** Pesi obiettivo (somma ≤ 1) calcolati con i dati fino alla chiusura di t-1; esecuzione all'apertura di t. */
type WeightFn = (t: number) => Record<string, number>;
function runEtf(weightFn: WeightFn, start: number, opts: { cashToBil?: boolean; cost?: number } = {}): number[] {
  const cashToBil = opts.cashToBil ?? true, cost = opts.cost ?? COST;
  const syms = [...U12, "BIL"];
  const shares: Record<string, number> = Object.fromEntries(syms.map((s) => [s, 0]));
  let cash = CAP, prevEq = CAP;
  const ret: number[] = new Array(N).fill(0);
  for (let t = start; t < N; t++) {
    if (t === start || firstOfMonth(t)) {
      const w = weightFn(t);
      const gross = Object.values(w).reduce((a, b) => a + b, 0);
      if (cashToBil) w.BIL = (w.BIL ?? 0) + Math.max(0, 1 - gross);
      const eqOpen = cash + syms.reduce((a, s) => a + shares[s] * E[s].o[t], 0);
      for (const s of syms) {
        const target = ((w[s] ?? 0) * eqOpen) / E[s].o[t];
        const d = target - shares[s];
        cash -= d * E[s].o[t] + cost * Math.abs(d) * E[s].o[t];
        shares[s] = target;
      }
    }
    const eq = cash + syms.reduce((a, s) => a + shares[s] * E[s].c[t], 0);
    ret[t] = eq / prevEq - 1;
    prevEq = eq;
  }
  return ret;
}
function trendWeights(sma: number, targetVol: number): WeightFn {
  return (t) => {
    const rets = U12.map((s) => dailyRets(s, t - 63, t));
    const raw = U12.map((s, i) => {
      let sum = 0;
      for (let k = t - sma; k < t; k++) sum += E[s].c[k];
      const v = sdev(rets[i]) * Math.sqrt(252);
      return E[s].c[t - 1] > sum / sma && v > 0 ? 1 / v : 0;
    });
    let pv = 0;
    for (let i = 0; i < U12.length; i++) for (let j = 0; j < U12.length; j++) pv += raw[i] * raw[j] * cov(rets[i], rets[j]) * 252;
    let w = raw.map((x) => (x * targetVol) / Math.sqrt(Math.max(pv, 1e-12)));
    const g = w.reduce((a, b) => a + b, 0);
    if (g > 1) w = w.map((x) => x / g);
    return Object.fromEntries(U12.map((s, i) => [s, w[i]]));
  };
}
const momScore = (s: string, t: number, months: number[]) => mean(months.map((m) => E[s].c[t - 1] / E[s].c[t - 1 - 21 * m] - 1));
function rotationWeights(months: number[], k: number): WeightFn {
  return (t) => {
    const bil = momScore("BIL", t, months);
    const w: Record<string, number> = {};
    for (const r of U12.map((s) => ({ s, v: momScore(s, t, months) })).sort((a, b) => b.v - a.v).slice(0, k)) if (r.v > bil) w[r.s] = 1 / k;
    return w;
  };
}

// walk-forward: a ogni gennaio dal 2019 sceglie la combinazione con lo Sharpe migliore su TUTTI i dati precedenti
function walkForward(runs: number[][], labels: string[], start: number) {
  const out = new Array(N).fill(0);
  const picks: string[] = [];
  let year = "", cur = 0;
  for (let t = start; t < N; t++) {
    const y = dates[t].slice(0, 4);
    if (y !== year) {
      year = y;
      if (y >= "2019") {
        let best = -Infinity;
        runs.forEach((r, i) => {
          const sh = sharpe(excess(r.slice(start, t), start));
          if (sh > best) (best = sh), (cur = i);
        });
        picks.push(`${y}:${labels[cur]}`);
      }
    }
    out[t] = runs[cur][t];
  }
  return { out, picks };
}

// ---------------------------------------------------------------- costruzione delle serie
const START = 253; // gennaio 2017: 12 mesi di storia per ogni segnale ETF
RF = new Array(N).fill(0).map((_, t) => (t > 0 ? E.BIL.c[t] / E.BIL.c[t - 1] - 1 : 0));
const base = loadRun("base");
const nohold = loadRun("nohold");
const base2x = loadRun("base", 2);
console.log(`ETF: ${dates[0]} → ${dates[N - 1]}; run intraday dal ${dates[base.first]}`);

const TF_GRID: { sma: number; vt: number }[] = [];
for (const sma of [100, 150, 200, 250]) for (const vt of [0.08, 0.1, 0.12]) TF_GRID.push({ sma, vt });
const RM_GRID: { months: number[]; k: number; label: string }[] = [];
for (const [lab, months] of [["3m", [3]], ["6m", [6]], ["12m", [12]], ["mix", [1, 3, 6, 12]]] as [string, number[]][])
  for (const k of [2, 3, 4, 5]) RM_GRID.push({ months, k, label: `${lab} top${k}` });

function buildCore(cost: number) {
  const tf = TF_GRID.map((g) => runEtf(trendWeights(g.sma, g.vt), START, { cost }));
  const rm = RM_GRID.map((g) => runEtf(rotationWeights(g.months, g.k), START, { cost }));
  const tfWF = walkForward(tf, TF_GRID.map((g) => `SMA${g.sma}/vol${g.vt * 100}`), START);
  const rmWF = walkForward(rm, RM_GRID.map((g) => g.label), START);
  return { tf, rm, tfWF, rmWF, core: tfWF.out.map((x, t) => 0.5 * x + 0.5 * rmWF.out[t]) };
}
const C1 = buildCore(COST);
const C2 = buildCore(COST * 2);
const mix = (...parts: [number[], number][]) => new Array(N).fill(0).map((_, t) => parts.reduce((s, [r, w]) => s + w * r[t], 0));

const series: Record<string, number[]> = {};
// come eravamo e come siamo
series["A0 Originale: ORB+VWAP+pairs (1/3)"] = mix([base.orb, 1 / 3], [base.vwap, 1 / 3], [nohold.pairs, 1 / 3]);
series["A1 Solo ORB"] = base.orb;
series["A2 Solo VWAP"] = base.vwap;
series["A3 Pairs fino al 21/10 (cassa a 0)"] = nohold.pairs;
series["A4 ATTUALE: pairs stop 40 (cassa a 0)"] = base.pairs;
// motori nuovi, parametri "da manuale" fissati a priori
const tfFixed = C1.tf[TF_GRID.findIndex((g) => g.sma === 200 && g.vt === 0.1)];
const rmFixed = C1.rm[RM_GRID.findIndex((g) => g.label === "mix top3")];
series["B1 TF SMA200 vol10 (LAB D) + BIL"] = tfFixed;
series["B2 RM mix top3 + BIL"] = rmFixed;
series["B3 CORE fisso 50/50 TF+RM"] = mix([tfFixed, 0.5], [rmFixed, 0.5]);
// walk-forward
series["C1 TF walk-forward"] = C1.tfWF.out;
series["C2 RM walk-forward"] = C1.rmWF.out;
series["C3 CORE walk-forward"] = C1.core;
series["D1 CORE WF + pairs 0,5x"] = mix([C1.core, 1], [base.pairs, 0.5]);
series["D2 PROPOSTA: CORE WF + pairs 1x"] = mix([C1.core, 1], [base.pairs, 1]);
series["D3 CORE WF + pairs 2x"] = mix([C1.core, 1], [base.pairs, 2]);
series["D4 proposta, costi x2"] = mix([C2.core, 1], [base2x.pairs, 1]);
series["D5 proposta con pairs pre-21/10"] = mix([C1.core, 1], [nohold.pairs, 1]);
// benchmark
const bh = (sym: string) => new Array(N).fill(0).map((_, t) => (t > START ? E[sym].c[t] / E[sym].c[t - 1] - 1 : 0));
series["Z1 SPY buy&hold"] = bh("SPY");
series["Z2 60/40 SPY/IEF mensile"] = runEtf(() => ({ SPY: 0.6, IEF: 0.4 }), START, { cashToBil: false });
series["Z3 BIL (T-bill)"] = bh("BIL");

// ---------------------------------------------------------------- report
function report(title: string, from: string, to: string) {
  const ix: number[] = [];
  for (let t = START + 1; t < N; t++) if (dates[t] >= from && dates[t] <= to) ix.push(t);
  const ds = ix.map((t) => dates[t]);
  console.log(`\n${title} (${ds[0]} → ${ds.at(-1)}, ${(ix.length / 252).toFixed(1)} anni) — netto di costi, 100k; Sharpe e t sul rendimento in eccesso dei T-bill`);
  console.log("strategia".padEnd(38), "rend/a".padStart(7), "vol".padStart(6), "Sharpe".padStart(7), "t".padStart(5), "DDmax".padStart(6), "sott'acqua".padStart(10), "12m<0".padStart(6), "  per anno");
  const out: Record<string, ReturnType<typeof metrics>> = {};
  for (const [n, s] of Object.entries(series)) {
    const m = metrics(ix.map((t) => s[t]), ds, ix[0]);
    out[n] = m;
    console.log(
      n.padEnd(38),
      ((m.cagr * 100).toFixed(1) + "%").padStart(7),
      ((m.vol * 100).toFixed(1) + "%").padStart(6),
      m.sharpe.toFixed(2).padStart(7),
      m.tstat.toFixed(1).padStart(5),
      ((m.dd * 100).toFixed(1) + "%").padStart(6),
      (m.maxUnderMonths.toFixed(0) + " mesi").padStart(10),
      ((m.neg12 * 100).toFixed(0) + "%").padStart(6),
      " ",
      Object.entries(m.years).map(([y, v]) => `${y.slice(2)}:${(v * 100).toFixed(0)}`).join(" ")
    );
  }
  return out;
}
const oos = report("FUORI CAMPIONE del walk-forward", "2019-01-01", "2026-12-31");
const recent = report("Ultimi 3,6 anni", "2023-03-22", "2026-12-31");
const sub1 = report("Sottoperiodo 2019-2021", "2019-01-01", "2021-12-31");
const sub2 = report("Sottoperiodo 2022 (azioni e bond in calo insieme)", "2022-01-01", "2022-12-31");
const full = report("Intero periodo (le varianti walk-forward usano i parametri fissi di partenza nel 2017-2018)", "2017-01-01", "2026-12-31");
const preTs = report("2017-2022: fuori dal campione (2023-2026) con cui è stato scelto lo stop a tempo a 40 sedute", "2017-01-01", "2022-12-31");
console.log("\nScelte walk-forward TF:", C1.tfWF.picks.join("  "));
console.log("Scelte walk-forward RM:", C1.rmWF.picks.join("  "));

const oosIx: number[] = [];
for (let t = START + 1; t < N; t++) if (dates[t] >= "2019-01-01") oosIx.push(t);
const corr = (a: number[], b: number[]) => {
  const x = oosIx.map((t) => a[t]), y = oosIx.map((t) => b[t]);
  return cov(x, y) / (sdev(x) * sdev(y));
};
console.log(
  `\nCorrelazioni 2019-2026: pairs-TF ${corr(base.pairs, C1.tfWF.out).toFixed(2)}, pairs-RM ${corr(base.pairs, C1.rmWF.out).toFixed(2)}, TF-RM ${corr(C1.tfWF.out, C1.rmWF.out).toFixed(2)}, pairs-SPY ${corr(base.pairs, series["Z1 SPY buy&hold"]).toFixed(2)}, CORE-SPY ${corr(C1.core, series["Z1 SPY buy&hold"]).toFixed(2)}`
);
for (const [name, r] of [["stop 40", base], ["pre-21/10", nohold]] as const) {
  const tr = r.trades.filter((x: any) => x.exitDay >= "2017-01-01");
  const win = tr.filter((x: any) => x.gross > 0);
  const reasons: Record<string, number> = {};
  for (const x of tr) reasons[x.reason] = (reasons[x.reason] ?? 0) + 1;
  console.log(
    `PAIRS ${name}: ${tr.length} trade chiusi dal 2017, ${((win.length / tr.length) * 100).toFixed(0)}% vinti (lordo), medio vinto ${mean(win.map((x: any) => x.gross)).toFixed(0)}$ / perso ${mean(tr.filter((x: any) => x.gross <= 0).map((x: any) => x.gross)).toFixed(0)}$, uscite ${JSON.stringify(reasons)}, coppie aperte in media ${mean(r.openPairs.slice(r.first)).toFixed(1)}`
  );
}

// serie mensili per il grafico
const monthly: Record<string, { m: string; eq: number }[]> = {};
for (const [n, s] of Object.entries(series)) {
  let eq = 1;
  const pts: { m: string; eq: number }[] = [];
  for (const t of oosIx) {
    eq *= 1 + s[t];
    if (t === N - 1 || dates[t + 1]?.slice(0, 7) !== dates[t].slice(0, 7)) pts.push({ m: dates[t].slice(0, 7), eq });
  }
  monthly[n] = pts;
}
writeFileSync(path.join(T, "redesign.json"), JSON.stringify({ oos, recent, sub1, sub2, full, preTs, tfPicks: C1.tfWF.picks, rmPicks: C1.rmWF.picks, monthly }));

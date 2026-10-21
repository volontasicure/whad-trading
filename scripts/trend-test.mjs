// Motore di rendimento alternativo (21/10/2026): trend following (momentum di serie storica) su un paniere
// diversificato di 12 ETF liquidi — azioni, bond, oro, materie prime, dollaro — su barre GIORNALIERE 2016-2026
// rettificate per split e dividendi (feed SIP, nessuna query al DB di produzione). Regole fissate PRIMA di vedere i
// risultati, nessuna taratura: 5 varianti + 2 benchmark, tutte riportate.
//   S1  long/flat, segno del rendimento a 12-1 mesi (252 sedute meno le ultime 21), vol target 10%, esposizione lorda max 100%
//   S2  come S1 con esposizione lorda max 200% (margine Reg T)
//   S3  long/short (short se negativo), vol target 10%, max 200%, costo di prestito 0,5%/anno sugli short
//   S4  filtro SMA200 per ogni ETF (long se sopra, liquidità se sotto), vol target 10%, max 100%
//   S5  S1 con vol target 8% e max 100% (profilo più prudente)
//   B1  SPY buy&hold      B2  60/40 SPY/IEF ribilanciato ogni mese
// Ribilanciamento mensile all'APERTURA del primo giorno di borsa del mese sul segnale della chiusura precedente;
// pesi inversi alla volatilità (63 sedute), scalati sulla volatilità di portafoglio stimata (covarianza 63 sedute);
// costo 0,023% per lato sul nozionale scambiato; liquidità a rendimento 0 (prudente: i T-bill oggi rendono ~4%).
// Uso: node scripts/trend-test.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

for (const l of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)="?(.*?)"?$/);
  if (m) process.env[m[1]] ??= m[2];
}
const H = { "APCA-API-KEY-ID": process.env.ALPACA_API_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET_KEY };
const SYMS = ["SPY", "QQQ", "IWM", "EFA", "EEM", "VNQ", "TLT", "IEF", "LQD", "GLD", "DBC", "UUP"];
const START = "2016-01-04";
const COST = 0.00023;
const BORROW = 0.005 / 252;

const cacheFile = path.join(tmpdir(), "trader", "etf_daily.json");
mkdirSync(path.dirname(cacheFile), { recursive: true });
let bars;
if (existsSync(cacheFile)) bars = JSON.parse(readFileSync(cacheFile, "utf8"));
else {
  bars = {};
  let token = null;
  for (;;) {
    const url = `https://data.alpaca.markets/v2/stocks/bars?symbols=${SYMS.join(",")}&timeframe=1Day&start=${START}&end=2026-10-16&adjustment=all&feed=sip&limit=10000${token ? "&page_token=" + token : ""}`;
    const j = await (await fetch(url, { headers: H })).json();
    for (const [s, a] of Object.entries(j.bars ?? {})) (bars[s] ??= []).push(...a);
    token = j.next_page_token;
    if (!token) break;
  }
  writeFileSync(cacheFile, JSON.stringify(bars));
}
// allinea sulle date in comune
const dateSets = SYMS.map((s) => new Set(bars[s].map((b) => b.t.slice(0, 10))));
const dates = [...dateSets[0]].filter((d) => dateSets.every((s) => s.has(d))).sort();
const idx = Object.fromEntries(SYMS.map((s) => [s, Object.fromEntries(bars[s].map((b) => [b.t.slice(0, 10), b]))]));
const O = SYMS.map((s) => dates.map((d) => idx[s][d].o));
const C = SYMS.map((s) => dates.map((d) => idx[s][d].c));
const N = dates.length, M = SYMS.length;
console.log(`${N} sedute comuni ${dates[0]} → ${dates[N - 1]}, ${M} ETF: ${SYMS.join(" ")}`);

const ret = (a, t) => a[t] / a[t - 1] - 1;
function sdev(x) { const m = x.reduce((a, b) => a + b, 0) / x.length; return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / x.length); }
function cov(x, y) { const mx = x.reduce((a, b) => a + b, 0) / x.length, my = y.reduce((a, b) => a + b, 0) / y.length; let s = 0; for (let i = 0; i < x.length; i++) s += (x[i] - mx) * (y[i] - my); return s / x.length; }

function isFirstOfMonth(t) { return t > 0 && dates[t].slice(0, 7) !== dates[t - 1].slice(0, 7); }

function run({ name, signal, target, cap, shortAllowed, borrow }) {
  let equity = 100_000, cash = equity;
  const shares = new Array(M).fill(0);
  const eq = []; let turnover = 0;
  const start = 260;
  for (let t = start; t < N; t++) {
    if (isFirstOfMonth(t)) {
      // segnali dalla chiusura del giorno precedente (t-1), esecuzione all'apertura di t
      const lastClose = C.map((c) => c[t - 1]);
      const win = 63;
      const rets = SYMS.map((_, i) => { const r = []; for (let k = t - win; k < t; k++) r.push(ret(C[i], k)); return r; });
      const vols = rets.map((r) => sdev(r) * Math.sqrt(252));
      const sig = SYMS.map((_, i) => signal(i, t - 1));
      const raw = sig.map((s, i) => (s === 0 || vols[i] === 0 ? 0 : s / vols[i]));
      // volatilità di portafoglio stimata con la covarianza a 63 sedute
      let pv = 0;
      for (let i = 0; i < M; i++) for (let j = 0; j < M; j++) pv += raw[i] * raw[j] * cov(rets[i], rets[j]) * 252;
      pv = Math.sqrt(Math.max(pv, 1e-12));
      let k = pv > 0 ? target / pv : 0;
      let w = raw.map((x) => x * k);
      const gross = w.reduce((a, b) => a + Math.abs(b), 0);
      if (gross > cap) w = w.map((x) => (x * cap) / gross);
      if (!shortAllowed) w = w.map((x) => Math.max(0, x));
      // equity all'apertura di t
      const eqOpen = cash + shares.reduce((a, sh, i) => a + sh * O[i][t], 0);
      for (let i = 0; i < M; i++) {
        const targetShares = (w[i] * eqOpen) / O[i][t];
        const dsh = targetShares - shares[i];
        const notional = Math.abs(dsh) * O[i][t];
        cash -= dsh * O[i][t] + COST * notional;
        turnover += notional;
        shares[i] = targetShares;
      }
    }
    // marca a mercato alla chiusura; costo di prestito sugli short
    const shortVal = shares.reduce((a, sh, i) => a + (sh < 0 ? -sh * C[i][t] : 0), 0);
    if (borrow) cash -= shortVal * BORROW;
    equity = cash + shares.reduce((a, sh, i) => a + sh * C[i][t], 0);
    eq.push(equity);
  }
  return { name, eq, turnover };
}

const mom = (i, t) => { const a = C[i][t - 21], b = C[i][t - 252]; return a / b - 1 > 0 ? 1 : 0; };
const momLS = (i, t) => { const a = C[i][t - 21], b = C[i][t - 252]; return a / b - 1 > 0 ? 1 : -1; };
const sma200 = (i, t) => { let s = 0; for (let k = t - 199; k <= t; k++) s += C[i][k]; return C[i][t] > s / 200 ? 1 : 0; };

const results = [
  run({ name: "S1 TSMOM long/flat vol10 cap100", signal: mom, target: 0.10, cap: 1.0, shortAllowed: false }),
  run({ name: "S2 TSMOM long/flat vol10 cap200", signal: mom, target: 0.10, cap: 2.0, shortAllowed: false }),
  run({ name: "S3 TSMOM long/short vol10 cap200", signal: momLS, target: 0.10, cap: 2.0, shortAllowed: true, borrow: true }),
  run({ name: "S4 SMA200 long/cash vol10 cap100", signal: sma200, target: 0.10, cap: 1.0, shortAllowed: false }),
  run({ name: "S5 TSMOM long/flat vol8 cap100", signal: mom, target: 0.08, cap: 1.0, shortAllowed: false }),
];
// Controllo di robustezza di S4 sui vicini (NON pre-registrate: servono solo a vedere se S4 è un picco isolato o un plateau)
const smaN = (n) => (i, t) => { let sum = 0; for (let k = t - n + 1; k <= t; k++) sum += C[i][k]; return C[i][t] > sum / n ? 1 : 0; };
results.push(
  run({ name: "S4a SMA150 vol10 cap100", signal: smaN(150), target: 0.10, cap: 1.0, shortAllowed: false }),
  run({ name: "S4b SMA250 vol10 cap100", signal: smaN(250), target: 0.10, cap: 1.0, shortAllowed: false }),
  run({ name: "S4c SMA200 vol8 cap100", signal: sma200, target: 0.08, cap: 1.0, shortAllowed: false }),
  run({ name: "S4d SMA200 vol12 cap100", signal: sma200, target: 0.12, cap: 1.0, shortAllowed: false })
);
// benchmark
const start = 260;
const spy = []; { const sh = 100_000 / O[0][start]; for (let t = start; t < N; t++) spy.push(sh * C[0][t]); }
const ief = SYMS.indexOf("IEF");
const b6040 = []; {
  let eqv = 100_000; let sS = 0, sI = 0, cashv = eqv;
  for (let t = start; t < N; t++) {
    if (t === start || isFirstOfMonth(t)) {
      const e = cashv + sS * O[0][t] + sI * O[ief][t];
      const newS = (0.6 * e) / O[0][t], newI = (0.4 * e) / O[ief][t];
      const tr = Math.abs(newS - sS) * O[0][t] + Math.abs(newI - sI) * O[ief][t];
      cashv = e - newS * O[0][t] - newI * O[ief][t] - COST * tr; sS = newS; sI = newI;
    }
    b6040.push(cashv + sS * C[0][t] + sI * C[ief][t]);
  }
}
results.push({ name: "B1 SPY buy&hold", eq: spy, turnover: 0 }, { name: "B2 60/40 SPY/IEF mensile", eq: b6040, turnover: 0 });

const dts = dates.slice(start);
const years = dts.length / 252;
function metrics(eq) {
  const r = eq.map((v, i) => (i ? v / eq[i - 1] - 1 : 0)).slice(1);
  const m = r.reduce((a, b) => a + b, 0) / r.length, sd = sdev(r);
  let peak = -Infinity, dd = 0;
  for (const v of eq) { peak = Math.max(peak, v); dd = Math.max(dd, (peak - v) / peak); }
  const byYear = {};
  dts.forEach((d, i) => { const y = d.slice(0, 4); (byYear[y] ??= { a: eq[i], b: eq[i] }).b = eq[i]; });
  const yr = {}; let prev = eq[0];
  for (const y of Object.keys(byYear)) { yr[y] = byYear[y].b / prev - 1; prev = byYear[y].b; }
  return { cagr: Math.pow(eq.at(-1) / eq[0], 1 / years) - 1, vol: sd * Math.sqrt(252), sharpe: (m / sd) * Math.sqrt(252), dd, yr };
}
console.log(`\nPeriodo ${dts[0]} → ${dts.at(-1)} (${years.toFixed(1)} anni), capitale 100k, netto costi, liquidità a 0%`);
console.log("strategia".padEnd(36), "rend/anno".padStart(10), "vol".padStart(6), "Sharpe".padStart(7), "DDmax".padStart(7), "rotaz/anno".padStart(11), "  per anno");
for (const r of results) {
  const x = metrics(r.eq);
  console.log(r.name.padEnd(36), (x.cagr * 100).toFixed(1).padStart(9) + "%", (x.vol * 100).toFixed(1).padStart(5) + "%", x.sharpe.toFixed(2).padStart(7), (x.dd * 100).toFixed(1).padStart(6) + "%", ((r.turnover / 100000) / years).toFixed(1).padStart(10) + "x", " ", Object.entries(x.yr).map(([y, v]) => `${y.slice(2)}:${(v * 100).toFixed(0)}`).join(" "));
}
// sottoperiodi
console.log("\nStabilità per sottoperiodo (rendimento annuo / Sharpe):");
const cuts = [["2016-2019", "2016", "2019"], ["2020-2022", "2020", "2022"], ["2023-2026", "2023", "2026"]];
for (const r of results) {
  const row = cuts.map(([lab, a, b]) => {
    const ix = dts.map((d, i) => [d.slice(0, 4), i]).filter(([y]) => y >= a && y <= b).map(([, i]) => i);
    const e = ix.map((i) => r.eq[i]);
    const rr = e.map((v, i) => (i ? v / e[i - 1] - 1 : 0)).slice(1);
    const yrs = ix.length / 252;
    return `${lab}: ${((Math.pow(e.at(-1) / e[0], 1 / yrs) - 1) * 100).toFixed(1)}% / ${((rr.reduce((x, y) => x + y, 0) / rr.length / sdev(rr)) * Math.sqrt(252)).toFixed(2)}`;
  });
  console.log(r.name.padEnd(36), row.join(" | "));
}
writeFileSync(path.join(tmpdir(), "trader", "trend_results.json"), JSON.stringify({ dates: dts, results: results.map((r) => ({ name: r.name, eq: r.eq })) }));

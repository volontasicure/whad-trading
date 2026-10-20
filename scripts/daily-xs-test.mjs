// Seconda fonte di rendimento a bassa rotazione (20/10/2026): test di strategie cross-sectional su barre
// GIORNALIERE dei 40 titoli (1.028 sedute, set 2022 → ott 2026, rettificate per split), niente intraday, zero
// query al DB (usa la cache daily_bars_all.json). Regole fissate PRIMA di vedere i risultati e NON tarate:
//   REV (reversal a breve): ogni H sedute, long i k titoli con rendimento peggiore a L sedute, short i k migliori;
//   MOM (momentum, controllo): l'opposto, su L lunga.
// Ingresso all'APERTURA della seduta successiva al segnale (nessun look-ahead), uscita all'apertura dopo H sedute,
// pesi uguali, dollar-neutral, esposizione lorda 1× il capitale, costo 0,023% per lato sul nozionale scambiato.
// "sector" = classifica dentro ogni settore (neutrale ai movimenti di settore).
// Uso: node scripts/daily-xs-test.mjs
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = tmpdir();
const cacheDir = path.join(tmp, readdirSync(tmp).filter((d) => d.startsWith("multiwin-")).sort().pop(), "cache");
const bars = JSON.parse(readFileSync(path.join(cacheDir, "daily_bars_all.json"), "utf8"));
const SECTORS = {
  AAPL: "tech", MSFT: "tech", NVDA: "tech", GOOGL: "tech", META: "tech", TXN: "tech", AVGO: "tech", ORCL: "tech", CRM: "tech",
  JPM: "fin", BAC: "fin", V: "fin", MA: "fin", WFC: "fin", GS: "fin",
  XOM: "energy", CVX: "energy", COP: "energy", SLB: "energy",
  KO: "staples", PEP: "staples", PG: "staples", WMT: "staples", COST: "staples",
  UNH: "health", JNJ: "health", ABBV: "health", LLY: "health", MRK: "health", TMO: "health",
};
const syms = Object.keys(bars);
const dates = bars[syms[0]].map((b) => b.t);
const N = dates.length;
const O = Object.fromEntries(syms.map((s) => [s, bars[s].map((b) => b.o)]));
const C = Object.fromEntries(syms.map((s) => [s, bars[s].map((b) => b.c)]));
const COST = 0.00023;
const sec = (s) => SECTORS[s] ?? "other";

function backtest({ name, L, H, k, dir, neutral }) {
  // dir = +1: long i peggiori (reversal); −1: long i migliori (momentum)
  const daily = new Array(N).fill(0);
  let prev = {}; // pesi correnti (frazione del capitale, con segno)
  let turnoverTotal = 0;
  for (let t = Math.max(L, 25); t + H + 1 < N; t += H) {
    const ret = {};
    for (const s of syms) ret[s] = C[s][t] / C[s][t - L] - 1;
    const groups = neutral === "sector" ? [...new Set(syms.map(sec))].map((g) => syms.filter((s) => sec(s) === g)) : [syms];
    const w = {};
    let legs = 0;
    for (const g of groups) {
      if (g.length < 2 * Math.min(k, Math.floor(g.length / 2))) continue;
      const kk = neutral === "sector" ? Math.max(1, Math.min(k, Math.floor(g.length / 3))) : k;
      const sorted = [...g].sort((a, b) => ret[a] - ret[b]);
      const losers = sorted.slice(0, kk);
      const winners = sorted.slice(-kk);
      for (const s of losers) w[s] = (w[s] ?? 0) + dir;
      for (const s of winners) w[s] = (w[s] ?? 0) - dir;
      legs += 2 * kk;
    }
    // normalizza a esposizione lorda 1 (somma |peso| = 1)
    const gross = Object.values(w).reduce((a, b) => a + Math.abs(b), 0) || 1;
    for (const s of Object.keys(w)) w[s] /= gross;
    // rendimento: apertura t+1 → apertura t+1+H
    const e = t + 1;
    const x = Math.min(t + 1 + H, N - 1);
    for (let d = e; d < x; d++) {
      // contributo giornaliero open(d)→open(d+1) dei pesi correnti (approssimazione: pesi costanti)
      let r = 0;
      for (const s of Object.keys(w)) r += w[s] * (O[s][d + 1] / O[s][d] - 1);
      daily[d + 1] += r;
    }
    // costi: nozionale scambiato = |w_nuovo − w_precedente| (ingresso/uscita), pagato all'apertura e
    let turn = 0;
    const all = new Set([...Object.keys(w), ...Object.keys(prev)]);
    for (const s of all) turn += Math.abs((w[s] ?? 0) - (prev[s] ?? 0));
    daily[e] -= COST * turn;
    turnoverTotal += turn;
    prev = w;
  }
  const rs = daily.slice(26);
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  const sd = Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / rs.length);
  let cum = 0, peak = 0, dd = 0;
  for (const r of rs) { cum += r; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  const blocks = [];
  const bl = Math.floor(rs.length / 9);
  for (let b = 0; b < 9; b++) blocks.push(rs.slice(b * bl, (b + 1) * bl).reduce((a, c) => a + c, 0));
  return { name, ann: mean * 252 * 100, vol: sd * Math.sqrt(252) * 100, sharpe: (mean / sd) * Math.sqrt(252), dd: dd * 100, turn: turnoverTotal / (rs.length / 252), blocks, pos: blocks.filter((v) => v > 0).length, daily };
}

const tests = [
  { name: "REV L5 H5 k5", L: 5, H: 5, k: 5, dir: +1 },
  { name: "REV L5 H5 k8", L: 5, H: 5, k: 8, dir: +1 },
  { name: "REV L10 H5 k5", L: 10, H: 5, k: 5, dir: +1 },
  { name: "REV L20 H10 k5", L: 20, H: 10, k: 5, dir: +1 },
  { name: "REV L5 H5 settore", L: 5, H: 5, k: 2, dir: +1, neutral: "sector" },
  { name: "REV L1 H1 k5 (alta rotazione)", L: 1, H: 1, k: 5, dir: +1 },
  { name: "MOM L60 H20 k5 (controllo)", L: 60, H: 20, k: 5, dir: -1 },
  { name: "MOM L120 H20 k5 (controllo)", L: 120, H: 20, k: 5, dir: -1 },
  { name: "MOM L60 H20 settore (controllo)", L: 60, H: 20, k: 2, dir: -1, neutral: "sector" },
];
console.log(`${N} sedute, ${syms.length} titoli; esposizione lorda 1×, costo ${(COST * 100).toFixed(3)}%/lato, ingresso all'apertura successiva\n`);
console.log("test".padEnd(34), "rend%/anno", "vol%", "sharpe", "DDmax%", "rotaz/anno", "blocchi+/9");
for (const t of tests) {
  const r = backtest(t);
  console.log(r.name.padEnd(34), r.ann.toFixed(1).padStart(9), r.vol.toFixed(1).padStart(6), r.sharpe.toFixed(2).padStart(6), r.dd.toFixed(1).padStart(7), r.turn.toFixed(0).padStart(10), `${r.pos}/9`.padStart(9), "  ", r.blocks.map((v) => (v * 100).toFixed(1).padStart(5)).join(" "));
}

// Simula regole di ammissione al capitale reale sulle serie giornaliere di backtest (11/10/2026).
// Domanda: il gate a 5 sedute di computeEligibility riammette l'ORB dopo una settimana lorda
// positiva (+402$) in una strategia negativa da mesi (−8.850$ netto su 101 sedute) — una soglia
// aggiuntiva su una finestra più lunga la terrebbe fuori senza escludere le strategie buone?
//
// Per ogni seduta d (dalla 21ª, per dare a tutte le regole la stessa storia minima) ogni regola
// decide quali strategie ammettere guardando SOLO le sedute precedenti; il capitale va in parti
// uguali alle ammesse (come computeWeights); il P&L della regola è Σ peso × netto di lab della
// strategia in quella seduta (netto di costi 0,023%/lato). Nessuna ammessa = liquidità, 0 P&L.
// Input: i JSON del backtest (BACKTEST_JSON) — dailyGross/dailyTurnover per strategia.
// Uso: node scripts/gate-sim.mjs <cartella con c0-recente.json e c0-fuori_campione.json>
import { readFileSync } from "node:fs";
import path from "node:path";

const dir = process.argv[2];
const COST = 0.00023;
const LAB_CAPITAL = 100_000;
const MAX_DD_PCT = 5;
const WARMUP = 20;

function loadNet(file) {
  const j = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
  const out = {};
  for (const k of ["orb", "vwap", "pairs"]) {
    const s = j.strategies[k];
    out[k] = s.dailyGross.map((g, i) => g - COST * s.dailyTurnover[i]);
  }
  return { net: out, n: j.sessionDates.length, first: j.sessionDates[0], last: j.sessionDates[j.sessionDates.length - 1] };
}

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
function maxDrawdownPct(series) {
  let cum = 0, peak = 0, dd = 0;
  for (const v of series) {
    cum += v;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
  }
  return (dd / LAB_CAPITAL) * 100;
}

// Regole di ammissione: (storico netto della strategia prima di d) → ammessa?
const rules = {
  "nessun gate (1/3 ciascuna)": () => true,
  "SOLO pairs": (h, k) => k === "pairs",
  "attuale: media5≥0 e DD20≤5%": (h) => avg(h.slice(-5)) >= 0 && maxDrawdownPct(h.slice(-20)) <= MAX_DD_PCT,
  "attuale + media10≥0": (h) => avg(h.slice(-5)) >= 0 && maxDrawdownPct(h.slice(-20)) <= MAX_DD_PCT && avg(h.slice(-10)) >= 0,
  "attuale + media20≥0": (h) => avg(h.slice(-5)) >= 0 && maxDrawdownPct(h.slice(-20)) <= MAX_DD_PCT && avg(h.slice(-20)) >= 0,
  "solo media20≥0 e DD20≤5%": (h) => avg(h.slice(-20)) >= 0 && maxDrawdownPct(h.slice(-20)) <= MAX_DD_PCT,
};

function simulate(win) {
  const res = {};
  for (const [name, fn] of Object.entries(rules)) {
    let total = 0;
    const days = { orb: 0, vwap: 0, pairs: 0, none: 0 };
    let sessions = 0;
    for (let d = WARMUP; d < win.n; d++) {
      const admitted = ["orb", "vwap", "pairs"].filter((k) => fn(win.net[k].slice(0, d), k));
      sessions++;
      if (admitted.length === 0) {
        days.none++;
        continue;
      }
      const w = 1 / admitted.length;
      for (const k of admitted) {
        total += w * win.net[k][d];
        days[k]++;
      }
    }
    res[name] = { total: Math.round(total), days, sessions };
  }
  return res;
}

const recent = loadNet("c0-recente.json");
const oos = loadNet("c0-fuori_campione.json");
const sr = simulate(recent);
const so = simulate(oos);

console.log(`Finestra recente: ${recent.n} sedute (${recent.first} → ${recent.last}); fuori campione: ${oos.n} (${oos.first} → ${oos.last}). Valutate dalla ${WARMUP + 1}ª seduta.`);
console.log("\nNetto per strategia nella finestra (tutte le sedute, lab 100k$):");
for (const k of ["orb", "vwap", "pairs"]) {
  const f = (w) => Math.round(w.net[k].reduce((a, b) => a + b, 0));
  console.log(`  ${k.padEnd(6)} recente ${String(f(recent)).padStart(7)} | fuori campione ${String(f(oos)).padStart(7)}`);
}
console.log("\nRegola".padEnd(34), "recente".padStart(9), "fuori camp.".padStart(12), "   sedute ammesse (orb/vwap/pairs/nessuna) recente | fuori camp.");
for (const name of Object.keys(rules)) {
  const a = sr[name], b = so[name];
  const dd = (x) => `${x.days.orb}/${x.days.vwap}/${x.days.pairs}/${x.days.none}`;
  console.log(name.padEnd(34), String(a.total).padStart(9), String(b.total).padStart(12), `   ${dd(a)} | ${dd(b)}`);
}

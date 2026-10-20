// Riepilogo delle run CONTINUE (892 sedute, libro aperto portato avanti) prodotte da `trader-sim.mjs --cont`.
// P&L tot = realizzato netto di costi + non realizzato finale (la misura corretta: il solo realizzato premia le strategie
// che lasciano aperti i perdenti). Uso: node scripts/trader-cont.mjs base frozen hold60 ...   (TRADER_OUT come altrove)
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const COST = 0.00023, CAP = 100_000;
const outRoot = process.env.TRADER_OUT || path.join(tmpdir(), "trader", "runs");
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
const q = (a, f) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(f * s.length))]; };

export function contSummary(name) {
  const f = path.join(outRoot, name, "cont.json");
  if (!existsSync(f)) return null;
  const j = JSON.parse(readFileSync(f, "utf8"));
  const p = j.strategies.pairs;
  const net = p.dailyGross.map((g, d) => g - COST * p.dailyTurnover[d]);
  const un = p.mtm.dailyEndUnreal;
  const mtm = net.map((n, d) => n + (un[d] - (d ? un[d - 1] : 0)));
  let c = 0;
  const eq = mtm.map((x) => (c += x));
  let peak = -Infinity, dd = 0, maxUW = 0, uw = 0;
  for (const e of eq) { if (e > peak) { peak = e; uw = 0; } else { uw++; maxUW = Math.max(maxUW, uw); } dd = Math.max(dd, peak - e); }
  const years = {};
  j.sessionDates.forEach((d, i) => { const y = d.slice(0, 4); years[y] = (years[y] ?? 0) + mtm[i]; });
  const log = (p.tradeLog ?? []).map((t) => ({ ...t, net: t.gross - COST * t.turnover }));
  const losers = log.filter((t) => t.net <= 0);
  const h25 = []; for (let i = 25; i < eq.length; i++) h25.push(eq[i] - eq[i - 25]);
  return {
    name, total: eq.at(-1), realized: sum(net), unreal: un.at(-1), trades: p.trades.n, losers: losers.length,
    loserMedHold: losers.length ? q(losers.map((t) => t.holdDays), .5) : 0, maxHold: log.length ? Math.max(...log.map((t) => t.holdDays)) : 0,
    sharpe: (mean(mtm) / std(mtm)) * Math.sqrt(252), volAnn: (std(mtm) * Math.sqrt(252) / CAP) * 100, dd: (dd / CAP) * 100, maxUW,
    years, expos: mean(p.exposure.dailyGrossNotional) / CAP * 100, neg25: h25.filter((v) => v < 0).length / h25.length * 100,
  };
}
const sum = (a) => a.reduce((x, y) => x + y, 0);
if (process.argv[1].endsWith("trader-cont.mjs")) {
  const names = process.argv.slice(2);
  console.log("config".padEnd(24), "P&L tot".padStart(8), "realizz".padStart(8), "aperto".padStart(7), "trade".padStart(5), "persi".padStart(6), "durata persi".padStart(12), "maxdur".padStart(7), "sharpe".padStart(7), "vol%".padStart(5), "DD%".padStart(5), "sotto-max".padStart(10), "espos%".padStart(7), "<0 su 5 sett".padStart(13), "  per anno");
  for (const n of names) {
    const r = contSummary(n);
    if (!r) { console.log(n.padEnd(24), "(manca)"); continue; }
    console.log(n.padEnd(24), String(Math.round(r.total)).padStart(8), String(Math.round(r.realized)).padStart(8), String(Math.round(r.unreal)).padStart(7), String(r.trades).padStart(5), String(r.losers).padStart(6), String(r.loserMedHold).padStart(12), String(r.maxHold).padStart(7), r.sharpe.toFixed(2).padStart(7), r.volAnn.toFixed(1).padStart(5), r.dd.toFixed(1).padStart(5), (r.maxUW + " sed").padStart(10), r.expos.toFixed(0).padStart(7), (r.neg25.toFixed(0) + "%").padStart(13), " ", Object.entries(r.years).map(([y, v]) => `${y}:${Math.round(v)}`).join(" "));
  }
}

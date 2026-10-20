// Confronto tra configurazioni del pairs rigiocate con scripts/trader-sim.mjs (9 finestre, netto di costi).
// La prima configurazione è il riferimento. Metriche:
//   P&L tot    realizzato netto di costi + NON realizzato a fine finestra, sommato sulle 9 finestre (valutazione corretta:
//              il solo realizzato è distorto perché i trade perdenti restano aperti più a lungo e a fine finestra
//              sparivano dal conto — censura a destra, scoperta il 20/10/2026)
//   realizz    solo il realizzato (la misura usata fino al 20/10/2026, mantenuta per confronto)
//   win+       finestre con netto positivo
//   ≥base      finestre in cui la configurazione batte il riferimento
//   trade      coppie chiuse; "aperte" = coppie ancora aperte a fine finestra non contate
//   sharpe     media / deviazione standard del P&L giornaliero a valore di mercato, annualizzato
//   ddMax      peggior drawdown a valore di mercato tra le finestre, % del capitale (100k × leva)
//   ddMed      drawdown mediano tra le finestre
//   espos      nozionale lordo medio a fine seduta in % del capitale (leva effettiva)
//   peggioreG  peggior giornata MTM, % del capitale
// Uso: node scripts/trader-report.mjs base shock3 mult2 [--windows 0,1,2]   (TRADER_OUT come in trader-sim.mjs)
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const COST = 0.00023;
const outRoot = process.env.TRADER_OUT || path.join(tmpdir(), "trader", "runs");
const args = process.argv.slice(2);
const wi = args.indexOf("--windows");
const only = wi >= 0 ? args[wi + 1].split(",").map(Number) : null;
const names = args.filter((a, i) => !a.startsWith("--") && (wi < 0 || (i !== wi + 1)));

const sum = (a) => a.reduce((x, y) => x + y, 0);
const mean = (a) => (a.length ? sum(a) / a.length : 0);
const std = (a) => {
  const m = mean(a);
  return Math.sqrt(mean(a.map((v) => (v - m) ** 2)));
};

export function loadConfig(name, mult = 1) {
  const res = [];
  for (let w = 0; w < 9; w++) {
    if (only && !only.includes(w)) continue;
    const f = path.join(outRoot, name, `w${w}.json`);
    if (!existsSync(f)) continue;
    const p = JSON.parse(readFileSync(f, "utf8")).strategies.pairs;
    const net = p.dailyGross.map((g, d) => g - COST * p.dailyTurnover[d]);
    const unreal = p.mtm.dailyEndUnreal;
    const mtmDaily = net.map((n, d) => n + (unreal[d] - (d ? unreal[d - 1] : 0)));
    let cum = 0, peak = 0, dd = 0;
    for (const x of mtmDaily) {
      cum += x;
      peak = Math.max(peak, cum);
      dd = Math.max(dd, peak - cum);
    }
    res.push({
      w,
      net: sum(net) + unreal[unreal.length - 1],
      realized: sum(net),
      trades: p.trades.n,
      wins: p.trades.wins,
      netDaily: net,
      mtmDaily,
      dd,
      minDay: Math.min(...mtmDaily),
      expos: p.exposure ? mean(p.exposure.dailyGrossNotional) : null,
      openPairs: p.exposure ? mean(p.exposure.dailyOpenPairs) : null,
      tradeLog: p.tradeLog ?? [],
    });
  }
  return res;
}

export function summarize(name, base, mult) {
  const r = loadConfig(name);
  // La "leva" (mult) non cambia il capitale: l equity resta 100k, aumenta il nozionale. Drawdown ed esposizione si misurano su 100k.
  const cap = 100_000;
  // Rendimento = P&L realizzato netto medio per seduta; rischio = deviazione standard del P&L giornaliero a valore
  // di mercato. Non si usa la media MTM concatenata: ogni finestra riparte da zero posizioni e perderebbe ogni
  // volta il non realizzato del libro aperto a fine finestra (~ -2k$), un artefatto della troncatura, non una perdita.
  const all = r.flatMap((x) => x.mtmDaily);
  const netAll = r.flatMap((x) => x.netDaily);
  const sharpe = all.length ? (mean(all) / std(all)) * Math.sqrt(252) : 0;
  const dds = r.map((x) => (x.dd / cap) * 100).sort((a, b) => a - b);
  return {
    name,
    n: r.length,
    net: sum(r.map((x) => x.net)),
    realized: sum(r.map((x) => x.realized)),
    winPos: r.filter((x) => x.net > 0).length,
    beatBase: base ? r.filter((x) => x.net > (base.find((b) => b.w === x.w)?.net ?? 0)).length : null,
    trades: sum(r.map((x) => x.trades)),
    sharpe,
    ddMax: dds.length ? dds[dds.length - 1] : 0,
    ddMed: dds.length ? dds[Math.floor(dds.length / 2)] : 0,
    expos: mean(r.map((x) => x.expos).filter((v) => v != null)) / cap * 100,
    worstDay: (Math.min(...r.map((x) => x.minDay)) / cap) * 100,
    perWindow: r.map((x) => Math.round(x.net)),
  };
}

if (process.argv[1].endsWith("trader-report.mjs")) {
  const base = names.length ? loadConfig(names[0]) : null;
  const rows = names.map((n) => {
    const mult = /mult(\d+(?:\.\d+)?)/.exec(n)?.[1];
    return summarize(n, n === names[0] ? null : base, mult ? Number(mult) : 1);
  });
  console.log("config".padEnd(26), "P&L tot".padStart(8), "realizz".padStart(8), "win+", "≥base", "trade".padStart(5), "sharpe".padStart(7), "ddMax%".padStart(7), "ddMed%".padStart(7), "espos%".padStart(7), "peggioreG%".padStart(11));
  for (const r of rows) {
    console.log(
      r.name.padEnd(26),
      String(Math.round(r.net)).padStart(8),
      String(Math.round(r.realized)).padStart(8),
      `${r.winPos}/${r.n}`.padStart(4),
      r.beatBase == null ? "  -  " : `${r.beatBase}/${r.n}`.padStart(5),
      String(r.trades).padStart(5),
      r.sharpe.toFixed(2).padStart(7),
      r.ddMax.toFixed(2).padStart(7),
      r.ddMed.toFixed(2).padStart(7),
      r.expos.toFixed(0).padStart(7),
      r.worstDay.toFixed(2).padStart(11)
    );
  }
  console.log("\nnetto per finestra (W0 = più recente):");
  for (const r of rows) console.log(" ", r.name.padEnd(26), r.perWindow.map((v) => String(v).padStart(6)).join(" "));
}

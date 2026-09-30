// Due controlli aggiuntivi su "overnight_drift" (server/overnightDrift.ts) prima di fidarsi
// del risultato del 29/9/2026 ("continuation" positiva su entrambe le finestre):
// 1. Sensibilità a TOP_K — se solo K=5 funziona e gli altri no, è overfitting sul numero
//    scelto, non un segnale vero.
// 2. Concentrazione — se uno o due titoli spiegano la maggior parte del P&L, non è un
//    effetto distribuito, è una scommessa su pochi nomi che si è rivelata giusta per caso.
// Uso: npx tsx scripts/overnight-drift-checks.ts [giorni=30]

import { runOneWindow } from "./backtest-overnight-drift.js";

const days = Number(process.argv[2]) || 30;
const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

async function sensitivityCheck() {
  console.log(`=== 1. Sensibilità a TOP_K (continuation, finestre di ${days} sedute) ===\n`);
  console.log("TOP_K".padEnd(8), "recente".padStart(9), "fuori camp.".padStart(12), "  verdetto");

  const ks = [2, 3, 5, 8, 10, 15];
  let oosAnchor: string | null = null;
  const results: { k: number; recent: number; oos: number }[] = [];
  for (const k of ks) {
    const recent = await runOneWindow(tomorrow, days, "continuation", k);
    oosAnchor ??= recent.firstDay;
    const oos = await runOneWindow(oosAnchor, days, "continuation", k);
    results.push({ k, recent: recent.pnl, oos: oos.pnl });
    const verdict = recent.pnl > 0 && oos.pnl > 0 ? "positiva su entrambe" : recent.pnl < 0 && oos.pnl < 0 ? "negativa su entrambe" : "misto";
    console.log(String(k).padEnd(8), String(recent.pnl).padStart(9), String(oos.pnl).padStart(12), " ", verdict);
  }

  const positiveCount = results.filter((r) => r.recent > 0 && r.oos > 0).length;
  console.log(`\n${positiveCount}/${ks.length} valori di TOP_K positivi su entrambe le finestre.`);
  return results;
}

async function concentrationCheck() {
  console.log(`\n=== 2. Concentrazione (continuation, TOP_K=5, finestra recente) ===\n`);
  const recent = await runOneWindow(tomorrow, days, "continuation", 5);
  const trades = recent.trades;

  const bySymbol = new Map<string, { n: number; pnl: number }>();
  for (const t of trades) {
    const cur = bySymbol.get(t.symbol) ?? { n: 0, pnl: 0 };
    cur.n++;
    cur.pnl += t.pnl;
    bySymbol.set(t.symbol, cur);
  }
  const bySymbolSorted = [...bySymbol.entries()].sort((a, b) => b[1].pnl - a[1].pnl);

  console.log(`${trades.length} trade totali, ${bySymbol.size} titoli distinti coinvolti.\n`);
  console.log("Migliori 5 titoli per contributo al P&L:");
  for (const [symbol, s] of bySymbolSorted.slice(0, 5)) console.log(`  ${symbol}: ${s.n} trade, netto ${s.pnl >= 0 ? "+" : ""}${s.pnl}`);
  console.log("Peggiori 5 titoli per contributo al P&L:");
  for (const [symbol, s] of bySymbolSorted.slice(-5).reverse()) console.log(`  ${symbol}: ${s.n} trade, netto ${s.pnl >= 0 ? "+" : ""}${s.pnl}`);

  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const top3Pnl = bySymbolSorted.slice(0, 3).reduce((s, [, v]) => s + v.pnl, 0);
  console.log(`\nP&L totale: ${totalPnl}. Solo i primi 3 titoli spiegano: ${top3Pnl} (${((top3Pnl / totalPnl) * 100).toFixed(0)}% del totale).`);

  const sortedByPnl = [...trades].sort((a, b) => b.pnl - a.pnl);
  const best5 = sortedByPnl.slice(0, 5);
  const worst5 = sortedByPnl.slice(-5).reverse();
  console.log("\nMigliori 5 trade singoli:");
  for (const t of best5) console.log(`  ${t.date} ${t.symbol} ${t.side}: +${t.pnl}`);
  console.log("Peggiori 5 trade singoli:");
  for (const t of worst5) console.log(`  ${t.date} ${t.symbol} ${t.side}: ${t.pnl}`);
  const best5Sum = best5.reduce((s, t) => s + t.pnl, 0);
  console.log(`\nI 5 migliori trade da soli spiegano: ${best5Sum} (${((best5Sum / totalPnl) * 100).toFixed(0)}% del totale netto).`);
}

async function run() {
  await sensitivityCheck();
  await concentrationCheck();
}

run().catch((err) => {
  console.error("Controlli falliti:", err);
  process.exit(1);
});

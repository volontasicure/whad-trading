// Prova a secco del LAB D (trend ETF): scarica dati veri da Alpaca, calcola segnali, pesi e le righe che il
// ribilanciamento aprirebbe OGGI, senza scrivere nulla (né DB né ordini). Uso: npx tsx scripts/trend-dry-run.ts
import { readFileSync } from "node:fs";
for (const l of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)="?(.*?)"?$/);
  if (m) process.env[m[1]] ??= m[2];
}
const { fetchCloses, fetchPrices } = await import("../server/trendRunner.js");
const { CAPITAL, TREND_SYMBOLS, computeTargetWeights, decideRebalance } = await import("../server/trendEtf.js");
const today = new Date().toISOString().slice(0, 10);
const [closes, prices] = await Promise.all([fetchCloses(today), fetchPrices()]);
const plan = computeTargetWeights(closes);
const d = decideRebalance(plan, CAPITAL, prices, []);
console.log(`Oggi ${today}. Esposizione lorda ${(plan.gross * 100).toFixed(0)}%, volatilità stimata ${(plan.portfolioVol * 100).toFixed(1)}%\n`);
console.log("ETF   chiusure  ultima    SMA200   dist.   vol    peso     azioni  controvalore");
for (const s of TREND_SYMBOLS) {
  const sig = plan.signals[s];
  const o = d.opens.find((x) => x.symbol === s);
  console.log(
    s.padEnd(5),
    String(closes[s].length).padStart(8),
    sig ? sig.close.toFixed(2).padStart(8) : "     n/d",
    sig ? sig.sma.toFixed(2).padStart(9) : "      n/d",
    sig ? `${((sig.close / sig.sma - 1) * 100).toFixed(1)}%`.padStart(7) : "    n/d",
    sig ? `${(sig.vol * 100).toFixed(0)}%`.padStart(5) : "  n/d",
    sig?.above ? `${(plan.weights[s] * 100).toFixed(1)}%`.padStart(8) : "   fuori",
    o ? String(o.qty).padStart(9) : "        -",
    o ? `${Math.round(o.qty * o.price)}$`.padStart(11) : ""
  );
}
console.log(`\nSi aprirebbero ${d.opens.length} posizioni, ${Math.round(d.opens.reduce((a, o) => a + o.qty * o.price, 0))}$ investiti su ${CAPITAL}$.`);
process.exit(0);

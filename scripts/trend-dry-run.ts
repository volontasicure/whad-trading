// Prova a secco dei lab ETF (LAB D trend, LAB E rotazione): scarica dati veri da Alpaca, calcola segnali, pesi e le
// righe che il ribilanciamento aprirebbe OGGI partendo da un lab vuoto, senza scrivere nulla (né DB né ordini).
// Uso: npx tsx scripts/trend-dry-run.ts
import { readFileSync } from "node:fs";
for (const l of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)="?(.*?)"?$/);
  if (m) process.env[m[1]] ??= m[2];
}
const { fetchCloses, fetchPrices } = await import("../server/trendRunner.js");
const { ALL_SYMBOLS, CAPITAL, CORE_PARAMS, computeRotationWeights, computeTargetWeights, decideRebalance } = await import("../server/trendEtf.js");
const today = new Date().toISOString().slice(0, 10);
const [closes, prices] = await Promise.all([fetchCloses(today), fetchPrices()]);
console.log(`Oggi ${today}, parametri ${CORE_PARAMS.version}: trend SMA${CORE_PARAMS.trend.smaDays}/vol${CORE_PARAMS.trend.targetVol * 100}%, rotazione ${CORE_PARAMS.rotation.months.join("-")} mesi top${CORE_PARAMS.rotation.topK}\n`);
for (const [name, plan] of [
  ["LAB D trend", computeTargetWeights(closes)],
  ["LAB E rotazione", computeRotationWeights(closes)],
] as const) {
  const d = decideRebalance(plan, CAPITAL, prices, []);
  console.log(`${name}: rischio ${(plan.gross * 100).toFixed(0)}%, BIL ${((plan.weights.BIL ?? 0) * 100).toFixed(0)}%${plan.cashScore != null ? `, soglia T-bill ${(plan.cashScore * 100).toFixed(2)}%` : ""}`);
  console.log("ETF   chiusure  ultima   segnale                 peso    azioni  controvalore");
  for (const s of ALL_SYMBOLS) {
    const sig = plan.signals[s];
    const sc = plan.scores?.[s];
    const o = d.opens.find((x) => x.symbol === s);
    const info = sc
      ? `#${sc.rank} mom ${(sc.score * 100).toFixed(1)}%${sc.selected ? " ✓" : ""}`
      : sig
        ? `${sig.above ? "sopra" : "sotto"} ${((sig.close / sig.sma - 1) * 100).toFixed(1)}% vol ${(sig.vol * 100).toFixed(0)}%`
        : "-";
    console.log(
      s.padEnd(5),
      String(closes[s]?.length ?? 0).padStart(8),
      (prices[s] != null ? prices[s].toFixed(2) : "n/d").padStart(8),
      " " + info.padEnd(23),
      `${((plan.weights[s] ?? 0) * 100).toFixed(1)}%`.padStart(6),
      o ? String(o.qty).padStart(9) : "        -",
      o ? `${Math.round(o.qty * o.price)}$`.padStart(11) : ""
    );
  }
  console.log(`→ ${d.opens.length} posizioni, ${Math.round(d.opens.reduce((a, o) => a + o.qty * o.price, 0))}$ su ${CAPITAL}$\n`);
}
process.exit(0);

// Ricostruisce `trade_review` per le sedute passate (stessa logica del rapporto serale,
// server/dailyReview.ts → reviewSession) e, con --report <data>, stampa il rapporto di quel giorno
// SENZA inviare la mail. Idempotente (chiave naturale). Leggero sul DB: poche centinaia di query
// piccole in tutto (vedi l'incidente di quota Neon dell'11/10/2026 in CLAUDE.md).
// Uso: npx tsx scripts/backfill-trade-review.ts            (tutte le sedute con trade chiusi)
//      npx tsx scripts/backfill-trade-review.ts --report 2026-10-12
import { readFileSync } from "node:fs";

for (const l of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)="?(.*?)"?$/);
  if (m) process.env[m[1]] ??= m[2];
}

const { db } = await import("../server/db.js");
const { fetchMarketSession } = await import("../server/marketHours.js");
const { reviewSession, buildReport } = await import("../server/dailyReview.js");

const reportIdx = process.argv.indexOf("--report");
if (reportIdx >= 0) {
  const date = process.argv[reportIdx + 1];
  const session = await fetchMarketSession(date);
  if (!session) throw new Error(`nessuna sessione il ${date}`);
  const r = await buildReport({ date, openUtc: session.openUtc, closeUtc: session.closeUtc });
  console.log(r.lines.join("\n"));
  process.exit(0);
}

const dates = (await db().query(
  `SELECT DISTINCT d FROM (
     SELECT (exit_time AT TIME ZONE 'UTC')::date::text AS d FROM real_positions WHERE status = 'closed' AND exit_time IS NOT NULL
     UNION
     SELECT (exit_time AT TIME ZONE 'UTC')::date::text AS d FROM lab_positions WHERE status = 'closed' AND exit_time IS NOT NULL
   ) x ORDER BY d`
)) as unknown as { d: string }[];

let totalReal = 0;
let totalLab = 0;
for (const { d } of dates) {
  const session = await fetchMarketSession(d);
  if (!session) {
    console.log(`${d}: nessuna sessione nel calendario, salto`);
    continue;
  }
  const r = await reviewSession({ date: d, openUtc: session.openUtc, closeUtc: session.closeUtc });
  totalReal += r.real.length;
  totalLab += r.lab.length;
  const causes = r.real.reduce<Record<string, number>>((acc, t) => ((acc[t.twin?.cause ?? "n/a"] = (acc[t.twin?.cause ?? "n/a"] ?? 0) + 1), acc), {});
  console.log(`${d}: ${r.real.length} reali, ${r.lab.length} lab — gemelli: ${JSON.stringify(causes)}`);
}
console.log(`\nTotale rivisti: ${totalReal} trade reali, ${totalLab} trade lab su ${dates.length} date.`);
process.exit(0);

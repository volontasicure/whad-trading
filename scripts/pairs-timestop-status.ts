// Stato dello stop a tempo del pairs: per ogni coppia aperta (reale e lab) le sedute già trascorse e la data di
// scadenza prevista (fine della 40ª seduta). Sola lettura. Uso: npx tsx scripts/pairs-timestop-status.ts
import { readFileSync } from "node:fs";
for (const l of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)="?(.*?)"?$/);
  if (m) process.env[m[1]] ??= m[2];
}
const { db } = await import("../server/db.js");
const { MAX_HOLD_SESSIONS, fetchSessionDates, sessionDateOf } = await import("../server/pairsTimeStop.js");
const today = new Date().toISOString().slice(0, 10);
const horizon = new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 10);
for (const table of ["real_positions", "lab_positions"] as const) {
  const rows = (await db().query(`SELECT pair_key, min(entry_time) AS t, count(*)::int AS legs FROM ${table} WHERE status = 'open' AND pair_key IS NOT NULL ${table === "lab_positions" ? "AND strategy_id = 'pairs'" : ""} GROUP BY pair_key ORDER BY min(entry_time)`)) as unknown as { pair_key: string; t: string; legs: number }[];
  console.log(`\n${table === "real_positions" ? "REALE" : "LAB pairs"}: ${rows.length} coppie aperte`);
  if (rows.length === 0) continue;
  const earliest = rows.map((r) => sessionDateOf(r.t)).sort()[0];
  const sessions = await fetchSessionDates(earliest, horizon);
  for (const r of rows) {
    const entry = sessionDateOf(r.t);
    const fromEntry = sessions.filter((d) => d >= entry);
    const held = fromEntry.filter((d) => d <= today).length;
    const expiry = fromEntry[MAX_HOLD_SESSIONS - 1] ?? "oltre l'orizzonte";
    console.log(`  ${r.pair_key.padEnd(10)} aperta il ${entry}  sedute ${String(held).padStart(2)}/${MAX_HOLD_SESSIONS}  scade a fine seduta del ${expiry}${r.legs < 2 ? "  (gamba sola!)" : ""}`);
  }
}
process.exit(0);

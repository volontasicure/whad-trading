// Casi sintetici per l'analisi dei trade (server/tradeReview.ts) e il registro dei segnali scartati
// (server/skippedSignals.ts). Il caso "CAT/GE 12/10" riproduce i numeri reali del 12/10/2026.
// Uso: npx tsx scripts/test-trade-review.ts
import assert from "node:assert/strict";
import {
  analyzeGap,
  buildDailyReport,
  buildFlags,
  computeExcursion,
  groupUnits,
  matchTwins,
  nearestZ,
  orbBreakout,
  vwapDistancePct,
  type Bar,
  type ClosedRow,
  type ReportInput,
  type ReviewedTrade,
} from "../server/tradeReview.js";
import { dedupeSkips, missingFrom } from "../server/skippedSignals.js";

let n = 0;
function test(name: string, fn: () => void) {
  fn();
  n++;
  console.log(`  ok  ${name}`);
}

const T0 = Date.parse("2026-10-07T13:35:00Z");
const row = (o: Partial<ClosedRow> & Pick<ClosedRow, "id" | "source" | "symbol" | "side">): ClosedRow => ({
  strategyId: "pairs",
  qty: 10,
  entryPrice: 100,
  exitPrice: 100,
  entryTime: new Date(T0).toISOString(),
  exitTime: new Date(T0 + 5 * 24 * 3600_000).toISOString(),
  realizedPnl: 0,
  exitReason: "exit_target",
  pairKey: null,
  conviction: null,
  ...o,
});
const bar = (minFromT0: number, h: number, l: number, c: number, vwap = 100): Bar => ({ t: T0 + minFromT0 * 60_000, h, l, c, vwap });

test("groupUnits: due gambe con stesso pair_key e stesso ingresso → un solo trade; singole separate", () => {
  const units = groupUnits([
    row({ id: 1, source: "real", symbol: "CAT", side: "SHORT", qty: 2, entryPrice: 838.37, exitPrice: 799.48, realizedPnl: 78, pairKey: "CAT/GE" }),
    row({ id: 2, source: "real", symbol: "GE", side: "LONG", qty: 7, entryPrice: 306.04, exitPrice: 309.06, realizedPnl: 21, pairKey: "CAT/GE" }),
    row({ id: 3, source: "real", symbol: "AAPL", side: "LONG", strategyId: "orb" }),
    row({ id: 4, source: "real", symbol: "AAPL", side: "LONG", strategyId: "orb", entryTime: "2026-10-08T14:00:00Z", exitTime: "2026-10-08T15:00:00Z" }),
  ]);
  assert.equal(units.length, 3);
  const pair = units.find((u) => u.subject === "CAT/GE")!;
  assert.equal(pair.side, "PAIR");
  assert.equal(pair.legs.length, 2);
  assert.equal(pair.grossPnl, 99);
  assert.equal(Math.round(pair.notional), Math.round(2 * 838.37 + 7 * 306.04));
  assert.equal(pair.costEst, 0, "reale: nessun costo stimato (lo slippage è già nei fill)");
  assert.equal(pair.holdMinutes, 5 * 24 * 60);
});

test("groupUnits: lab → costo stimato 0,023%/lato sul nozionale di ingresso+uscita", () => {
  const [u] = groupUnits([row({ id: 1, source: "lab", symbol: "X", side: "LONG", qty: 100, entryPrice: 50, exitPrice: 51, realizedPnl: 100 })]);
  assert.ok(Math.abs(u.costEst - 0.00023 * 100 * 101) < 1e-9);
  assert.ok(Math.abs(u.netPnl - (100 - 0.00023 * 100 * 101)) < 1e-9);
});

test("groupUnits: gamba orfana → exitReason orphan_leg", () => {
  const [u] = groupUnits([row({ id: 9, source: "real", symbol: "TXN", side: "SHORT", pairKey: "TXN/AVGO", exitReason: "orphan_leg" })]);
  assert.equal(u.exitReason, "orphan_leg");
});

test("groupUnits: gambe chiuse in giorni diversi (JPM/BAC 30/9 + 1/10) → un solo trade, P&L complessivo, motivo manuale", () => {
  const [u] = groupUnits([
    row({ id: 77, source: "real", symbol: "JPM", side: "SHORT", pairKey: "JPM/BAC", realizedPnl: 79, exitReason: "eod", exitTime: "2026-09-30T19:40:00.000Z" }),
    row({ id: 78, source: "real", symbol: "BAC", side: "LONG", pairKey: "JPM/BAC", realizedPnl: -262, exitReason: "manual_cleanup_orphan_leg", exitTime: "2026-10-01T14:21:00.000Z" }),
  ]);
  assert.equal(u.legs.length, 2);
  assert.equal(u.grossPnl, -183);
  assert.equal(u.exitTime, "2026-10-01T14:21:00.000Z");
  assert.equal(u.exitReason, "manual_cleanup_orphan_leg");
});

test("groupUnits: due uscite ordinarie → vale il motivo della gamba chiusa per ultima", () => {
  const [u] = groupUnits([
    row({ id: 1, source: "real", symbol: "A", side: "LONG", pairKey: "A/B", exitReason: "eod", exitTime: "2026-10-08T19:40:00.000Z" }),
    row({ id: 2, source: "real", symbol: "B", side: "SHORT", pairKey: "A/B", exitReason: "exit_target", exitTime: "2026-10-12T13:30:00.000Z" }),
  ]);
  assert.equal(u.exitReason, "exit_target");
});

test("computeExcursion: LONG singola usa minimi/massimi delle barre, include il punto di uscita", () => {
  const [u] = groupUnits([
    row({ id: 1, source: "real", symbol: "X", side: "LONG", qty: 10, entryPrice: 100, exitPrice: 103, realizedPnl: 30, exitTime: new Date(T0 + 60 * 60_000).toISOString() }),
  ]);
  const { mae, mfe } = computeExcursion(u, { X: [bar(0, 101, 99, 100), bar(5, 105, 98, 104), bar(10, 104, 100, 103)] });
  assert.equal(mae, -20); // 10 × (98 − 100)
  assert.equal(mfe, 50); // 10 × (105 − 100)
});

test("computeExcursion: SHORT singola, segno invertito", () => {
  const [u] = groupUnits([
    row({ id: 1, source: "real", symbol: "X", side: "SHORT", qty: 10, entryPrice: 100, exitPrice: 97, realizedPnl: 30, exitTime: new Date(T0 + 60 * 60_000).toISOString() }),
  ]);
  const { mae, mfe } = computeExcursion(u, { X: [bar(0, 102, 99, 100), bar(5, 106, 96, 97)] });
  assert.equal(mae, -60); // 10 × (100 − 106)
  assert.equal(mfe, 40); // 10 × (100 − 96)
});

test("computeExcursion: coppia, valore combinato sulle sole barre comuni", () => {
  const [u] = groupUnits([
    row({ id: 1, source: "real", symbol: "A", side: "SHORT", qty: 1, entryPrice: 100, exitPrice: 100, realizedPnl: 0, pairKey: "A/B", exitTime: new Date(T0 + 60 * 60_000).toISOString() }),
    row({ id: 2, source: "real", symbol: "B", side: "LONG", qty: 1, entryPrice: 100, exitPrice: 100, realizedPnl: 0, pairKey: "A/B", exitTime: new Date(T0 + 60 * 60_000).toISOString() }),
  ]);
  const { mae, mfe } = computeExcursion(u, {
    A: [bar(0, 0, 0, 105), bar(5, 0, 0, 90)],
    B: [bar(0, 0, 0, 98), bar(5, 0, 0, 100), bar(10, 0, 0, 50)], // la barra a 10' esiste solo per B: ignorata
  });
  // t0: SHORT A (−5) + LONG B (−2) = −7 ; t5: +10 + 0 = +10
  assert.equal(mae, -7);
  assert.equal(mfe, 10);
});

test("computeExcursion: nessuna barra → null, mai un numero inventato", () => {
  const [u] = groupUnits([row({ id: 1, source: "real", symbol: "X", side: "LONG" })]);
  assert.deepEqual(computeExcursion(u, {}), { mae: null, mfe: null });
});

test("nearestZ / vwapDistancePct / orbBreakout", () => {
  assert.equal(nearestZ([{ t: 1000, z: 2.1 }, { t: 400_000, z: 3 }], 1500), 2.1);
  assert.equal(nearestZ([{ t: 400_000, z: 3 }], 1500), null, "fuori tolleranza");
  assert.ok(Math.abs(vwapDistancePct(102, [bar(0, 0, 0, 0, 100), bar(5, 0, 0, 0, 101)], T0 + 6 * 60_000)! - (102 - 101)) < 0.02);
  assert.equal(orbBreakout(102, "LONG", { high: 100, low: 90 }), 0.2);
  assert.equal(orbBreakout(88, "SHORT", { high: 100, low: 90 }), 0.2);
});

test("matchTwins: abbina per strategia/titoli/lato e ingresso nello stesso tick; ognuno una sola volta", () => {
  const real = groupUnits([row({ id: 1, source: "real", symbol: "JNJ", side: "LONG", strategyId: "pairs", pairKey: "JNJ/ABBV" }), row({ id: 2, source: "real", symbol: "ABBV", side: "SHORT", strategyId: "pairs", pairKey: "JNJ/ABBV" })]);
  const lab = groupUnits([
    row({ id: 10, source: "lab", symbol: "JNJ", side: "LONG", strategyId: "pairs", pairKey: "JNJ/ABBV" }),
    row({ id: 11, source: "lab", symbol: "ABBV", side: "SHORT", strategyId: "pairs", pairKey: "JNJ/ABBV" }),
    row({ id: 12, source: "lab", symbol: "PEP", side: "LONG", strategyId: "pairs", pairKey: "PEP/PG" }),
  ]);
  const m = matchTwins(real, lab);
  assert.equal(m.size, 1);
  assert.equal(lab[m.get(0)!].subject, "JNJ/ABBV");
});

test("matchTwins: ingresso a più di 6 minuti → nessun gemello", () => {
  const real = groupUnits([row({ id: 1, source: "real", symbol: "X", side: "LONG", strategyId: "orb" })]);
  const lab = groupUnits([row({ id: 2, source: "lab", symbol: "X", side: "LONG", strategyId: "orb", entryTime: new Date(T0 + 10 * 60_000).toISOString() })]);
  assert.equal(matchTwins(real, lab).size, 0);
});

test("analyzeGap: stesso tick e motivo, rendimento uguale → in_line", () => {
  const [r] = groupUnits([row({ id: 1, source: "real", symbol: "X", side: "LONG", qty: 10, entryPrice: 100, exitPrice: 101, realizedPnl: 10 })]);
  const [l] = groupUnits([row({ id: 2, source: "lab", symbol: "X", side: "LONG", qty: 50, entryPrice: 100, exitPrice: 101, realizedPnl: 50 })]);
  const g = analyzeGap(r, l);
  assert.equal(g.cause, "in_line");
  assert.ok(Math.abs(g.returnGapPct!) < 1e-9, "size diversa ma stesso rendimento sul nozionale");
});

test("analyzeGap: stessa uscita ma fill peggiore del reale → slippage, segni corretti", () => {
  // LONG: il reale compra a 100,30 invece di 100 (sfavorevole) e vende a 100,60 invece di 101 (sfavorevole)
  const [r] = groupUnits([row({ id: 1, source: "real", symbol: "X", side: "LONG", qty: 10, entryPrice: 100.3, exitPrice: 100.6, realizedPnl: 3 })]);
  const [l] = groupUnits([row({ id: 2, source: "lab", symbol: "X", side: "LONG", qty: 10, entryPrice: 100, exitPrice: 101, realizedPnl: 10 })]);
  const g = analyzeGap(r, l);
  assert.equal(g.cause, "slippage");
  assert.ok(Math.abs(g.entrySlipPct! - 0.3) < 1e-6);
  assert.ok(Math.abs(g.exitSlipPct! - (0.4 / 101) * 100) < 1e-6, "uscita a 100,6 invece di 101: costo +0,396%");
  assert.ok(g.returnGapPct! < -0.1);
});

test("analyzeGap: SHORT con fill migliore del lab → slippage negativo (a favore)", () => {
  const [r] = groupUnits([row({ id: 1, source: "real", symbol: "X", side: "SHORT", qty: 10, entryPrice: 100.2, exitPrice: 99, realizedPnl: 12 })]);
  const [l] = groupUnits([row({ id: 2, source: "lab", symbol: "X", side: "SHORT", qty: 10, entryPrice: 100, exitPrice: 99, realizedPnl: 10 })]);
  const g = analyzeGap(r, l);
  assert.ok(g.entrySlipPct! < 0, "SHORT che vende più alto = a favore");
});

test("analyzeGap: uscita in un altro tick → exit_timing (non slippage); senza gemello → no_twin", () => {
  const [r] = groupUnits([row({ id: 1, source: "real", symbol: "X", side: "LONG", exitTime: new Date(T0 + 3600_000).toISOString() })]);
  const [l] = groupUnits([row({ id: 2, source: "lab", symbol: "X", side: "LONG", exitTime: new Date(T0 + 2 * 3600_000).toISOString() })]);
  assert.equal(analyzeGap(r, l).cause, "exit_timing");
  assert.equal(analyzeGap(r, null).cause, "no_twin");
  assert.equal(analyzeGap(r, null, true).cause, "entry_timing", "il lab teneva la stessa posizione, entrata altrove: non è un'anomalia");
});

test("registro segnali: missingFrom isola i bloccati; dedupeSkips tiene il segnale più forte", () => {
  const lab = [{ k: "PEP/PG", z: 2.3 }, { k: "JNJ/ABBV", z: 2.1 }];
  const real = [{ k: "JNJ/ABBV", z: 2.1 }];
  assert.deepEqual(missingFrom(lab, real, (x) => x.k).map((x) => x.k), ["PEP/PG"]);
  const d = dedupeSkips([
    { strategyId: "pairs", subject: "PEP/PG", reason: "occupied_symbol", signal: 2.1 },
    { strategyId: "pairs", subject: "PEP/PG", reason: "occupied_symbol", signal: 2.6, detail: "PEP tenuto da pairs (KO/PEP)" },
    { strategyId: "pairs", subject: "PEP/PG", reason: "cooldown_stop" },
  ]);
  assert.equal(d.length, 2);
  assert.equal(d.find((x) => x.reason === "occupied_symbol")!.signal, 2.6);
});

test("rapporto: segnala lo scarto di esecuzione, il trade senza gemello e la coppia vecchia", () => {
  const [ru] = groupUnits([row({ id: 1, source: "real", symbol: "X", side: "LONG", strategyId: "orb", qty: 10, entryPrice: 100.3, exitPrice: 100.6, realizedPnl: 3 })]);
  const [lu] = groupUnits([row({ id: 2, source: "lab", symbol: "X", side: "LONG", strategyId: "orb", qty: 10, entryPrice: 100, exitPrice: 101, realizedPnl: 10 })]);
  const [orphan] = groupUnits([row({ id: 3, source: "real", symbol: "TXN", side: "SHORT", strategyId: "pairs", pairKey: "TXN/AVGO", exitReason: "orphan_leg", realizedPnl: 33 })]);
  const mk = (u: typeof ru, twin: ReviewedTrade["twin"]): ReviewedTrade => ({ ...u, mae: -5, mfe: 20, entrySignal: null, exitSignal: null, twin });
  const input: ReportInput = {
    date: "2026-10-13",
    equity: { equity: 95000, lastEquity: 95100 },
    real: [mk(ru, analyzeGap(ru, lu)), mk(orphan, analyzeGap(orphan, null))],
    lab: [mk(lu, null)],
    openPairs: [{ pairKey: "JPM/BAC", legs: "JPM short 7 / BAC long 44", sessionsHeld: 12, unrealized: -600, mae: -700, entryZ: 2.4, currentZ: 4.7 }],
    skipped: [{ strategyId: "pairs", subject: "PEP/PG", reason: "occupied_symbol", detail: "PEP tenuto da pairs (KO/PEP)", signal: 2.3, ticks: 70 }],
    health: { totalTicks: 100, openTicks: 78, maxGapMin: 5.9, firstUtc: "13:31", lastUtc: "19:55", errorNotes: [] },
    consistencyLines: ["Riconciliazione broker↔DB: OK (6 posizioni sul broker)"],
    anomalies: [],
    cumulative: [{ source: "real", strategyId: "pairs", n: 10, net: 17, wins: 6, avgMae: -80 }],
  };
  const flags = buildFlags(input);
  assert.ok(flags.some((f) => f.includes("Scarto di esecuzione") && f.includes("X")));
  assert.ok(flags.some((f) => f.includes("senza gemello") && f.includes("TXN/AVGO")));
  assert.ok(flags.some((f) => f.includes("aperta da 12 sedute")));
  assert.ok(flags.some((f) => f.includes("vicino allo stop")));
  assert.ok(flags.some((f) => f.includes("bloccat")));
  const text = buildDailyReport(input).join("\n");
  assert.ok(text.includes("recap seduta 2026-10-13"));
  assert.ok(text.includes("sotto 40 trade reali di pairs (ora 10)"));
});

test("rapporto: giornata pulita → nessun punto di attenzione", () => {
  const input: ReportInput = {
    date: "2026-10-13",
    equity: { equity: 95100, lastEquity: 95000 },
    real: [],
    lab: [],
    openPairs: [],
    skipped: [],
    health: { totalTicks: 100, openTicks: 78, maxGapMin: 5.2, firstUtc: "13:31", lastUtc: "19:55", errorNotes: [] },
    consistencyLines: [],
    anomalies: [],
    cumulative: [],
  };
  assert.equal(buildFlags(input).length, 0);
  assert.ok(buildDailyReport(input)[2].startsWith("ESITO: nessun punto di attenzione"));
});

console.log(`\n${n} test passati`);

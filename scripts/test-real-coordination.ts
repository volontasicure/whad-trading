// Casi sintetici per il coordinamento tra strategie sul conto reale (10/10/2026): EOD per
// quantità (server/realEod.ts), gambe orfane e simboli occupati (server/realSymbols.ts).
// Il primo caso riproduce ESATTAMENTE lo scenario AVGO/TXN dell'8/10/2026.
// Uso: npx tsx scripts/test-real-coordination.ts
import assert from "node:assert/strict";
import { decideRealEodCloses, type AlpacaEodPosition, type RealEodOpenRow } from "../server/realEod.js";
import { findOrphanLegIds, occupiedSymbols } from "../server/realSymbols.js";

const pos = (symbol: string, unrealized = 10): AlpacaEodPosition => ({ symbol, unrealized_pl: String(unrealized), current_price: "100" });
const row = (id: number, symbol: string, side: "LONG" | "SHORT", qty: number, pair_key: string | null = null): RealEodOpenRow => ({
  id, symbol, pair_key, side, qty, entry_price: 100,
});

let n = 0;
function test(name: string, fn: () => void) {
  fn();
  n++;
  console.log(`  ok  ${name}`);
}

test("scenario AVGO 8/10: gamba pairs AVGO 6 + VWAP AVGO 16 → vende SOLO 16, TXN (coppia completa) intatta", () => {
  const plans = decideRealEodCloses(
    [pos("AVGO"), pos("TXN")],
    [row(131, "TXN", "SHORT", 8, "TXN/AVGO"), row(132, "AVGO", "LONG", 6, "TXN/AVGO"), row(173, "AVGO", "LONG", 16)]
  );
  assert.equal(plans.length, 1);
  assert.equal(plans[0].position.symbol, "AVGO");
  assert.equal(plans[0].whole, false);
  assert.deepEqual(plans[0].rows.map((r) => r.id), [173]);
  assert.equal(plans[0].orderSide, "sell");
  assert.equal(plans[0].orderQty, 16);
});

test("gamba orfana (TXN short 8 senza AVGO) → chiusa per intero, motivo orphan_leg", () => {
  const plans = decideRealEodCloses([pos("TXN")], [row(131, "TXN", "SHORT", 8, "TXN/AVGO")]);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].whole, true);
  assert.deepEqual(plans[0].rows.map((r) => r.id), [131]);
});

test("solo singole sullo stesso simbolo (ORB + VWAP) → chiusura intera, entrambe le righe", () => {
  const plans = decideRealEodCloses([pos("AAPL")], [row(1, "AAPL", "LONG", 5), row(2, "AAPL", "LONG", 7)]);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].whole, true);
  assert.deepEqual(plans[0].rows.map((r) => r.id).sort(), [1, 2]);
});

test("coppia completa (due gambe) → mai chiusa per regola EOD", () => {
  const plans = decideRealEodCloses([pos("KO"), pos("PEP")], [row(1, "KO", "SHORT", 27, "KO/PEP"), row(2, "PEP", "LONG", 18, "KO/PEP")]);
  assert.equal(plans.length, 0);
});

test("gamba pairs short 3 + singola long 16 sullo stesso simbolo → vende 16 (posizione netta 13 → −3)", () => {
  const plans = decideRealEodCloses(
    [pos("X"), pos("Y")],
    [row(1, "X", "SHORT", 3, "X/Y"), row(2, "Y", "LONG", 5, "X/Y"), row(3, "X", "LONG", 16)]
  );
  assert.equal(plans.length, 1);
  assert.equal(plans[0].orderSide, "sell");
  assert.equal(plans[0].orderQty, 16);
  assert.deepEqual(plans[0].rows.map((r) => r.id), [3]);
});

test("singole che si compensano (long 5 + short 5) accanto a una gamba pairs → nessun ordine (qty 0)", () => {
  const plans = decideRealEodCloses(
    [pos("X"), pos("Y")],
    [row(1, "X", "LONG", 5), row(2, "X", "SHORT", 5), row(3, "X", "LONG", 4, "X/Y"), row(4, "Y", "SHORT", 4, "X/Y")]
  );
  assert.equal(plans.length, 1);
  assert.equal(plans[0].whole, false);
  assert.equal(plans[0].orderQty, 0);
  assert.deepEqual(plans[0].rows.map((r) => r.id).sort(), [1, 2]);
});

test("posizione broker senza righe: chiusa solo se in utile (regola prudente invariata)", () => {
  assert.equal(decideRealEodCloses([pos("Z", 25)], []).length, 1);
  assert.equal(decideRealEodCloses([pos("Z", -25)], []).length, 0);
});

test("findOrphanLegIds: una sola riga per pair_key = orfana; due = coppia; singole ignorate", () => {
  const ids = findOrphanLegIds([
    { id: 1, pair_key: "A/B" },
    { id: 2, pair_key: "C/D" },
    { id: 3, pair_key: "C/D" },
    { id: 4, pair_key: null },
  ]);
  assert.deepEqual([...ids], [1]);
});

test("occupiedSymbols: tutte le strategie, meno le righe già chiuse in questo tick", () => {
  const rows = [
    { id: 1, symbol: "AVGO", pair_key: "TXN/AVGO" },
    { id: 2, symbol: "CAT", pair_key: null },
    { id: 3, symbol: "GE", pair_key: "CAT/GE" },
  ];
  assert.deepEqual([...occupiedSymbols(rows, new Set())].sort(), ["AVGO", "CAT", "GE"]);
  assert.deepEqual([...occupiedSymbols(rows, new Set([2]))].sort(), ["AVGO", "GE"]);
});

console.log(`\n${n} casi passati.`);

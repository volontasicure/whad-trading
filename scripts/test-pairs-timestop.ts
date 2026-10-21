// Collaudo dello stop a tempo del pairs (server/pairsTimeStop.ts + piano EOD reale in server/realEod.ts).
// Uso: npx tsx scripts/test-pairs-timestop.ts
import assert from "node:assert/strict";
import { MAX_HOLD_SESSIONS, expiredPairKeys, sessionDateOf } from "../server/pairsTimeStop.js";
import { decideRealEodCloses, type AlpacaEodPosition, type RealEodOpenRow } from "../server/realEod.js";

let n = 0;
function test(name: string, fn: () => void) {
  fn();
  n++;
  console.log(`  ok  ${name}`);
}

// Sedute sintetiche: 60 giorni feriali consecutivi dal 2026-01-05 (nessun festivo: il conteggio è sulla lista passata).
const sessions: string[] = [];
for (let d = new Date("2026-01-05T00:00:00Z"); sessions.length < 60; d = new Date(d.getTime() + 86_400_000)) {
  const wd = d.getUTCDay();
  if (wd !== 0 && wd !== 6) sessions.push(d.toISOString().slice(0, 10));
}
const upTo = (i: number) => sessions.slice(0, i + 1); // sedute fino alla i-esima inclusa (0-based)

test("la seduta di apertura conta come 1: scade alla chiusura della 40ª seduta, non prima", () => {
  const info = [{ pairKey: "A/B", entryDate: sessions[0] }];
  assert.equal(expiredPairKeys(info, upTo(38)).size, 0, "39 sedute: ancora aperta");
  assert.deepEqual([...expiredPairKeys(info, upTo(39))], ["A/B"], "40 sedute: scade");
  assert.deepEqual([...expiredPairKeys(info, upTo(55))], ["A/B"], "oltre: resta scaduta (recupero se un tick è saltato)");
});

test("le sedute si contano sulla lista del calendario: weekend e festivi non contano", () => {
  const entry = sessions[5];
  const info = [{ pairKey: "A/B", entryDate: entry }];
  const held = upTo(44).filter((d) => d >= entry).length; // sedute 5..44 = 40
  assert.equal(held, 40);
  assert.equal(expiredPairKeys(info, upTo(44)).size, 1);
  assert.equal(expiredPairKeys(info, upTo(43)).size, 0);
});

test("ogni coppia ha la sua data di apertura", () => {
  const out = expiredPairKeys(
    [
      { pairKey: "OLD/PAIR", entryDate: sessions[0] },
      { pairKey: "NEW/PAIR", entryDate: sessions[30] },
    ],
    upTo(45)
  );
  assert.deepEqual([...out], ["OLD/PAIR"]);
});

test("data della seduta da un orario UTC (apertura 13:30 UTC e chiusura tarda restano nello stesso giorno)", () => {
  assert.equal(sessionDateOf("2026-10-12T13:30:05.000Z"), "2026-10-12");
  assert.equal(sessionDateOf(new Date("2026-10-12T20:55:00Z")), "2026-10-12");
});

test("il valore in produzione è 40", () => assert.equal(MAX_HOLD_SESSIONS, 40));

// ---- piano EOD reale ----
const pos = (symbol: string): AlpacaEodPosition => ({ symbol, unrealized_pl: "-10", current_price: "100" });
const row = (id: number, symbol: string, side: "LONG" | "SHORT", qty: number, pair_key: string | null = null): RealEodOpenRow => ({ id, symbol, pair_key, side, qty, entry_price: 100 });

test("coppia scaduta: entrambe le gambe si chiudono per intero, motivo = stop a tempo", () => {
  const rows = [row(1, "KO", "SHORT", 27, "KO/PEP"), row(2, "PEP", "LONG", 18, "KO/PEP")];
  const plans = decideRealEodCloses([pos("KO"), pos("PEP")], rows, new Set(["KO/PEP"]));
  assert.equal(plans.length, 2);
  assert.ok(plans.every((p) => p.whole));
  assert.deepEqual(plans.map((p) => p.rows[0].id).sort(), [1, 2]);
  assert.ok(plans.every((p) => p.timeStopPairs?.includes("KO/PEP")));
});

test("coppia NON scaduta: resta aperta (nessuna regola EOD sui pairs)", () => {
  const rows = [row(1, "KO", "SHORT", 27, "KO/PEP"), row(2, "PEP", "LONG", 18, "KO/PEP")];
  assert.equal(decideRealEodCloses([pos("KO"), pos("PEP")], rows, new Set()).length, 0);
  assert.equal(decideRealEodCloses([pos("KO"), pos("PEP")], rows).length, 0, "senza il terzo argomento: comportamento precedente");
});

test("solo la coppia scaduta si chiude, l'altra resta", () => {
  const rows = [
    row(1, "KO", "SHORT", 27, "KO/PEP"),
    row(2, "PEP", "LONG", 18, "KO/PEP"),
    row(3, "JPM", "SHORT", 7, "JPM/BAC"),
    row(4, "BAC", "LONG", 44, "JPM/BAC"),
  ];
  const plans = decideRealEodCloses([pos("KO"), pos("PEP"), pos("JPM"), pos("BAC")], rows, new Set(["JPM/BAC"]));
  assert.deepEqual(plans.map((p) => p.position.symbol).sort(), ["BAC", "JPM"]);
});

test("titolo condiviso tra una gamba scaduta e una gamba di un'altra coppia viva: ordine parziale per la sola quantità scaduta", () => {
  // PEP long 18 in KO/PEP (scaduta) e PEP long 39 in PEP/PG (viva) sullo stesso titolo del conto
  const rows = [
    row(1, "KO", "SHORT", 27, "KO/PEP"),
    row(2, "PEP", "LONG", 18, "KO/PEP"),
    row(5, "PEP", "LONG", 39, "PEP/PG"),
    row(6, "PG", "SHORT", 32, "PEP/PG"),
  ];
  const plans = decideRealEodCloses([pos("KO"), pos("PEP"), pos("PG")], rows, new Set(["KO/PEP"]));
  const pep = plans.find((p) => p.position.symbol === "PEP")!;
  assert.equal(pep.whole, false);
  assert.equal(pep.orderSide, "sell");
  assert.equal(pep.orderQty, 18, "vende 18, non 57");
  assert.deepEqual(pep.rows.map((r) => r.id), [2]);
  assert.equal(plans.find((p) => p.position.symbol === "KO")!.whole, true);
  assert.equal(plans.find((p) => p.position.symbol === "PG"), undefined, "PG (coppia viva) non si tocca");
});

test("una gamba orfana di una coppia scaduta resta orfana (motivo orphan_leg, non stop a tempo)", () => {
  const rows = [row(1, "KO", "SHORT", 27, "KO/PEP")]; // PEP già chiusa: gamba sola
  const plans = decideRealEodCloses([pos("KO")], rows, new Set(["KO/PEP"]));
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0].timeStopPairs, []);
});

console.log(`\n${n} test passati`);

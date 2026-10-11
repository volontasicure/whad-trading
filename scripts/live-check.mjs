// Verifica "dal vivo" del sistema durante/dopo una seduta (sola lettura): DB, cadenza dei tick,
// allocazione reale, gambe orfane, riconciliazione broker↔DB, ordini fermi, uscite EOD, riga sessions.
// Pensato per il primo giro con tutto attivo (12/10/2026): pairs unico ammesso al reale, stop 6,0,
// EOD per quantità, un titolo = una strategia, gambe orfane chiuse, costi nel lab. Leggero sul DB
// (poche query piccole) — vedi l'incidente di quota Neon dell'11/10/2026 in CLAUDE.md.
// Uso: node scripts/live-check.mjs [YYYY-MM-DD]   (default: oggi UTC)
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

for (const l of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)="?(.*?)"?$/);
  if (m) process.env[m[1]] ??= m[2];
}
const sql = neon(process.env.POSTGRES_URL);
const base = "https://paper-api.alpaca.markets";
const H = { "APCA-API-KEY-ID": process.env.ALPACA_API_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET_KEY };
const day = process.argv[2] || new Date().toISOString().slice(0, 10);
const sessionStart = `${day}T13:00:00Z`; // ≤ apertura NYSE (13:30Z in EDT, 14:30Z in EST)
const sessionEnd = `${day}T22:30:00Z`;

const results = [];
const ok = (m) => results.push(["OK ", m]);
const warn = (m) => results.push(["ATT", m]);
const bad = (m) => results.push(["ERR", m]);
const fmt = (d) => new Date(d).toISOString().slice(11, 16);
const get = async (p) => (await fetch(base + p, { headers: H })).json();

// 1. DB e orologio
try {
  await sql`SELECT 1`;
  ok("Database raggiungibile");
} catch (e) {
  bad(`Database NON raggiungibile: ${String(e.message).slice(0, 120)}`);
  for (const [s, m] of results) console.log(`[${s}] ${m}`);
  process.exit(0);
}
const clock = await get("/v2/clock");
console.log(`Orologio: mercato ${clock.is_open ? "APERTO" : "chiuso"} | ora broker ${clock.timestamp.slice(0, 19)} | prossima apertura ${clock.next_open.slice(0, 16)}`);

// 2. Cadenza dei tick
const ticks = await sql`SELECT ran_at, market_open, note FROM tick_log WHERE ran_at >= ${sessionStart} AND ran_at < ${sessionEnd} ORDER BY ran_at`;
const open = ticks.filter((t) => t.market_open);
if (open.length === 0) {
  warn(`Nessun tick di mercato aperto il ${day} (${ticks.length} tick totali in giornata)`);
} else {
  ok(`${open.length} tick a mercato aperto, dal ${fmt(open[0].ran_at)} al ${fmt(open[open.length - 1].ran_at)} UTC`);
  let maxGap = 0;
  let gapAt = "";
  for (let i = 1; i < open.length; i++) {
    const g = (new Date(open[i].ran_at) - new Date(open[i - 1].ran_at)) / 60000;
    if (g > maxGap) { maxGap = g; gapAt = fmt(open[i - 1].ran_at); }
  }
  if (maxGap > 10) warn(`Buco nei tick: ${maxGap.toFixed(0)} min dopo le ${gapAt} UTC`);
  else ok(`Cadenza regolare (buco massimo ${maxGap.toFixed(1)} min)`);
  const ageMin = (Date.now() - new Date(open[open.length - 1].ran_at)) / 60000;
  if (clock.is_open && ageMin > 10) bad(`Ultimo tick di ${ageMin.toFixed(0)} minuti fa a mercato APERTO`);
}

// 3. Errori nelle note e allocazione reale
// "0 fallite" è un esito normale: conta solo un numero di fallimenti > 0, un errore o lo stop giornaliero.
const errs = ticks.filter((t) => /errore|STOP GIORNALIERO|\b[1-9]\d* fallit/i.test(t.note || ""));
if (errs.length === 0) ok("Nessun errore/stop/fallimento nelle note dei tick");
else {
  const uniq = [...new Set(errs.map((t) => (t.note.match(/(errore[^·]*|STOP GIORNALIERO|[^·]*fallit[^·]*)/i)?.[0] || t.note).slice(0, 140)))];
  bad(`${errs.length} tick con errori/stop. Distinti: ${uniq.slice(0, 3).join(" || ")}`);
}
const realStrategies = new Set();
for (const t of open) {
  const m = (t.note || "").match(/reale: ([a-z_+]+)/);
  if (m) m[1].split("+").forEach((s) => realStrategies.add(s));
}
if (open.length > 0) {
  if (realStrategies.size === 0) warn("Nessuna riga `reale:` nelle note (esecuzione reale saltata? debriefing non confermato?)");
  else if ([...realStrategies].every((s) => s === "pairs")) ok("Allocazione reale: solo pairs");
  else bad(`Allocazione reale include altre strategie: ${[...realStrategies].join(", ")}`);
}
const skipped = open.filter((t) => /debriefing non confermato/i.test(t.note || "")).length;
if (skipped > 0) warn(`${skipped} tick con esecuzione reale saltata: debriefing di oggi non confermato (nessun nuovo ingresso reale)`);

// 4. Gamba orfana TXN e righe aperte
const orphan = await sql`SELECT id, symbol, status, exit_reason, exit_time FROM real_positions WHERE id = 131`;
if (orphan[0]) {
  if (orphan[0].status === "closed") ok(`TXN orfana (riga 131) chiusa: motivo ${orphan[0].exit_reason}, ${fmt(orphan[0].exit_time)} UTC`);
  else if (clock.is_open && open.length > 0) bad("TXN orfana (riga 131) ancora APERTA dopo i tick di oggi");
  else warn("TXN orfana (riga 131) ancora aperta: verrà chiusa al primo tick a mercato aperto");
}
const rows = await sql`SELECT id, strategy_id, symbol, side, qty::float q, pair_key, entry_time FROM real_positions WHERE status='open' ORDER BY id`;
const byKey = {};
for (const r of rows) if (r.pair_key) (byKey[r.pair_key] ??= []).push(r);
const orphans = Object.entries(byKey).filter(([, l]) => l.length < 2).map(([k]) => k);
const nonPairs = rows.filter((r) => !r.pair_key);
if (orphans.length === 0) ok(`Nessuna gamba orfana (${Object.keys(byKey).length} coppie aperte: ${Object.keys(byKey).join(", ") || "—"})`);
else warn(`Gambe orfane aperte: ${orphans.join(", ")}`);
if (nonPairs.length > 0) warn(`Posizioni reali non-pairs aperte: ${nonPairs.map((r) => `${r.strategy_id}:${r.symbol}`).join(", ")}`);

// 5. Riconciliazione broker↔DB e ordini fermi
const positions = await get("/v2/positions");
const brokerQty = Object.fromEntries(positions.map((p) => [p.symbol, Number(p.qty)]));
const dbQty = {};
for (const r of rows) dbQty[r.symbol] = (dbQty[r.symbol] ?? 0) + (r.side === "LONG" ? r.q : -r.q);
const mism = [...new Set([...Object.keys(brokerQty), ...Object.keys(dbQty)])].filter((s) => (brokerQty[s] ?? 0) !== (dbQty[s] ?? 0));
if (mism.length === 0) ok(`Broker e DB concordano su ${Object.keys(brokerQty).length} posizioni`);
else bad(`Differenze broker↔DB: ${mism.map((s) => `${s} broker ${brokerQty[s] ?? 0} / DB ${dbQty[s] ?? 0}`).join("; ")}`);
const openOrders = await get("/v2/orders?status=open&limit=50");
if (openOrders.length === 0) ok("Nessun ordine aperto sul broker");
else warn(`${openOrders.length} ordini aperti sul broker: ${openOrders.map((o) => `${o.symbol} ${o.side} ${o.qty}`).join(", ")}`);

// 6. Operatività della giornata (reale e lab)
const realToday = await sql`SELECT strategy_id, count(*)::int n, coalesce(sum(realized_pnl),0)::float pnl FROM real_positions WHERE status='closed' AND exit_time >= ${sessionStart} AND exit_time < ${sessionEnd} GROUP BY 1`;
const realEntries = await sql`SELECT strategy_id, count(*)::int n FROM real_positions WHERE entry_time >= ${sessionStart} AND entry_time < ${sessionEnd} GROUP BY 1`;
const labEntries = await sql`SELECT strategy_id, count(*)::int n FROM lab_positions WHERE entry_time >= ${sessionStart} AND entry_time < ${sessionEnd} GROUP BY 1`;
console.log(`Reale — ingressi: ${JSON.stringify(Object.fromEntries(realEntries.map((r) => [r.strategy_id, r.n])))} | chiuse oggi: ${JSON.stringify(Object.fromEntries(realToday.map((r) => [r.strategy_id, `${r.n} (${Math.round(r.pnl)}$)`])))}`);
console.log(`Lab   — ingressi: ${JSON.stringify(Object.fromEntries(labEntries.map((r) => [r.strategy_id, r.n])))}`);
const badReal = realEntries.filter((r) => r.strategy_id !== "pairs");
if (badReal.length > 0) bad(`Ingressi reali non-pairs oggi: ${badReal.map((r) => `${r.strategy_id}=${r.n}`).join(", ")}`);
else ok("Nessun ingresso reale non-pairs oggi");
const vwapShort = labEntries.find((r) => r.strategy_id === "vwap_reversion");
console.log(`VWAP lab oggi: ${vwapShort?.n ?? 0} ingressi (atteso ~1/giorno con soglia 2,5%, prima ~13)`);

// 7. Equity e fase EOD
const acct = await get("/v2/account");
const dpct = ((Number(acct.equity) - Number(acct.last_equity)) / Number(acct.last_equity)) * 100;
console.log(`Equity ${Number(acct.equity).toFixed(0)}$ (${dpct >= 0 ? "+" : ""}${dpct.toFixed(2)}% su ieri; limite perdita giornaliera −1%)`);
if (dpct <= -1) warn("Perdita giornaliera oltre −1%: nuovi ingressi bloccati");
const eod = ticks.filter((t) => /EOD reale/.test(t.note || ""));
if (eod.length > 0) {
  const last = eod[eod.length - 1].note;
  const fails = (last.match(/EOD reale: (\d+) chiuse\/(\d+) fallite/) || []);
  if (fails[2] && Number(fails[2]) > 0) bad(`EOD reale con ${fails[2]} chiusure fallite: ${last.slice(last.indexOf("EOD reale")).slice(0, 160)}`);
  else ok(`EOD reale eseguito: ${last.slice(last.indexOf("EOD reale"), last.indexOf("EOD reale") + 70)}`);
  const sess = await sql`SELECT strategy_id, net::float net, trades FROM sessions WHERE trading_date = ${day}`;
  if (sess[0]) ok(`Riga sessions di oggi: ${sess[0].strategy_id}, netto lab ${Math.round(sess[0].net)}$, ${sess[0].trades} trade`);
  else warn("Riga sessions di oggi non ancora scritta");
} else {
  console.log("Fase EOD: non ancora raggiunta (finestra 19:40-20:00 UTC in EDT)");
}

console.log("\n=== ESITO ===");
for (const [s, m] of results) console.log(`[${s}] ${m}`);
const nBad = results.filter((r) => r[0] === "ERR").length;
const nWarn = results.filter((r) => r[0] === "ATT").length;
console.log(`\nTotale: ${results.length - nBad - nWarn} ok, ${nWarn} attenzioni, ${nBad} errori`);

// Chiusura reale di fine seduta (EOD) e finalizzazione della riga sessions — logica condivisa
// tra api/cron/tick.ts (percorso primario dal 29/9/2026) e api/cron/eod-close.ts (backup
// ridondante). Entrambi chiamano le stesse funzioni qui sotto: nessuna logica duplicata.
//
// Storia: fino al 24/9/2026 questa logica viveva solo in api/cron/eod-close.ts, su un cron
// GitHub Actions separato (eod-close.yml, tre schedule ravvicinati per coprire l'incertezza
// sull'ora legale). Dal 24/9 quel workflow ha iniziato ad arrivare sempre più in ritardo —
// verificato con `gh run view --log`, non solo dal timestamp della lista: invocazioni fino a
// 3-5 ore dopo la chiusura reale, e a quell'ora il codice trova il mercato già chiuso e
// no-op'pa ("skipped: mercato chiuso") invece di chiudere le posizioni. Causa probabile:
// GitHub deprioritizza sotto carico i workflow con molti trigger ravvicinati (3 cron × ogni 5
// min ≈ 20 trigger in 100 minuti) — tick.yml (un solo cron ogni 5 minuti tutto il giorno) non
// ha mai avuto questo problema, sempre puntuale. Conseguenza reale: nessuna chiusura EOD reale
// dal 28/9, SBUX (ORB) rimasta aperta due notti di fila — protetta comunque dal bracket order
// sul broker, non scoperta come NKE il 18-22/9, ma la regola "chiudi sempre a fine giornata"
// del 22/9/2026 di fatto non scattava più.
//
// Fix, 29/9/2026: percorso primario spostato dentro tick.ts (stesso scheduler affidabile della
// rete di sicurezza EOD dei lab, server/labEod.ts). api/cron/eod-close.ts resta attivo come
// backup, per la stessa ragione di ridondanza già applicata a tick.ts/eod-close.yml in
// passato ("nessuno scheduler singolo è affidabile") — stavolta il backup era quello rotto,
// non il principale, lezione da tenere a mente se dovesse succedere di nuovo.

import { alpacaFetch } from "./alpaca.js";
import { db } from "./db.js";
import { fetchMarketSession } from "./marketHours.js";
import { CAPITAL } from "./pairsTrading.js";
import { todayResultFor, STRATEGY_IDS } from "./debrief.js";
import { computeEligibility } from "./strategyAllocation.js";

export interface AlpacaEodPosition {
  symbol: string;
  unrealized_pl: string;
  current_price: string;
}

export interface RealEodOpenRow {
  symbol: string;
  pair_key: string | null;
}

interface AlpacaOrder {
  id: string;
  filled_avg_price: string | null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Le gambe stop/target dei bracket order (ORB reale) tengono "prenotate" le azioni: finché
 * sono aperte, Alpaca rifiuta la chiusura manuale della posizione. Il 18/9/2026 questo ha
 * fatto fallire ogni tentativo EOD (closed 0, failed 4) e 4 posizioni profittevoli hanno
 * passato il weekend. Va quindi annullato ogni ordine aperto sul simbolo prima di chiudere,
 * aspettando che l'annullamento (asincrono lato broker) sia effettivo.
 */
async function cancelOpenOrders(symbol: string): Promise<void> {
  const openOrders = await alpacaFetch<AlpacaOrder[]>(`/v2/orders?status=open&symbols=${encodeURIComponent(symbol)}&nested=false&limit=50`);
  await Promise.allSettled(openOrders.map((o) => alpacaFetch(`/v2/orders/${o.id}`, { method: "DELETE" })));
  for (let i = 0; i < 6; i++) {
    const still = await alpacaFetch<AlpacaOrder[]>(`/v2/orders?status=open&symbols=${encodeURIComponent(symbol)}&nested=false&limit=50`);
    if (still.length === 0) return;
    await sleep(500);
  }
}

/** Chiude la posizione sul broker e registra l'uscita nelle righe real_positions aperte per quel simbolo. */
async function closeAndRecord(p: AlpacaEodPosition): Promise<void> {
  await cancelOpenOrders(p.symbol);
  const order = await alpacaFetch<AlpacaOrder>(`/v2/positions/${encodeURIComponent(p.symbol)}`, { method: "DELETE" });

  let exitPrice = order.filled_avg_price ? Number(order.filled_avg_price) : null;
  for (let i = 0; i < 3 && exitPrice == null; i++) {
    await sleep(500);
    const check = await alpacaFetch<AlpacaOrder>(`/v2/orders/${order.id}`);
    if (check.filled_avg_price) exitPrice = Number(check.filled_avg_price);
  }
  const price = exitPrice ?? Number(p.current_price);

  const rows = (await db()`
    SELECT id, side, qty::float8 AS qty, entry_price::float8 AS entry_price
    FROM real_positions WHERE symbol = ${p.symbol} AND status = 'open'
  `) as unknown as { id: number; side: "LONG" | "SHORT"; qty: number; entry_price: number }[];
  for (const r of rows) {
    const dir = r.side === "LONG" ? 1 : -1;
    const realizedPnl = Math.round(r.qty * (price - r.entry_price) * dir);
    await db()`
      UPDATE real_positions
      SET status = 'closed', exit_price = ${price}, exit_time = now(), realized_pnl = ${realizedPnl},
          exit_reason = 'eod', broker_exit_order_id = ${order.id}
      WHERE id = ${r.id}
    `;
  }
}

/**
 * Determina quali posizioni Alpaca chiudere a fine giornata: le singole (ORB/VWAP — nessun
 * pair_key in real_positions) sempre, in utile o in perdita, dal 22/9/2026 — stessa regola e
 * stessa evidenza da backtest di decideLabEodCloses (server/labEod.ts, dettagli lì). Le
 * gambe di una coppia (pair_key valorizzato) restano sulla regola precedente: chiudono
 * insieme solo se il P&L combinato è positivo, mai una gamba sola, stesso principio di
 * decidePairsEodCloses (server/pairsTrading.ts) — riprodotto qui sui dati Alpaca. Una
 * posizione Alpaca senza riga corrispondente in real_positions (non dovrebbe succedere) resta
 * sulla vecchia regola prudente "chiudi solo se in utile".
 */
export function decideRealEodCloses(positions: AlpacaEodPosition[], openRows: RealEodOpenRow[]): AlpacaEodPosition[] {
  const rowBySymbol = new Map(openRows.map((r) => [r.symbol, r]));
  const pairGroups = new Map<string, RealEodOpenRow[]>();
  for (const r of openRows) {
    if (!r.pair_key) continue;
    if (!pairGroups.has(r.pair_key)) pairGroups.set(r.pair_key, []);
    pairGroups.get(r.pair_key)!.push(r);
  }

  const symbolsToClose = new Set<string>();
  for (const p of positions) {
    const row = rowBySymbol.get(p.symbol);
    if (!row) {
      if (Number(p.unrealized_pl) > 0) symbolsToClose.add(p.symbol);
      continue;
    }
    if (!row.pair_key) symbolsToClose.add(p.symbol);
  }
  for (const legs of pairGroups.values()) {
    if (legs.length < 2) continue; // gamba già orfana per altra causa, non compito di questa funzione
    let combined = 0;
    let allPriced = true;
    for (const leg of legs) {
      const pos = positions.find((p) => p.symbol === leg.symbol);
      if (!pos) {
        allPriced = false;
        break;
      }
      combined += Number(pos.unrealized_pl);
    }
    if (allPriced && combined > 0) for (const leg of legs) symbolsToClose.add(leg.symbol);
  }

  return positions.filter((p) => symbolsToClose.has(p.symbol));
}

export interface RealEodCloseSummary {
  evaluated: number;
  closed: number;
  failed: number;
  errors: string[];
  symbols: string[];
}

/**
 * Orchestratore: legge posizioni Alpaca + righe real_positions aperte, decide e chiude. Il
 * chiamante decide quando invocarla (vicino alla chiusura) — questa funzione non controlla da
 * sola l'orologio di mercato, per restare chiamabile sia da tick.ts (che lo controlla già per
 * conto suo, nearClose) sia da eod-close.ts (che ha il proprio controllo separato).
 */
export async function runRealEodClose(): Promise<RealEodCloseSummary> {
  const positions = await alpacaFetch<AlpacaEodPosition[]>("/v2/positions");
  const openRows = (await db()`
    SELECT symbol, pair_key FROM real_positions WHERE status = 'open'
  `) as unknown as RealEodOpenRow[];
  const toClose = decideRealEodCloses(positions, openRows);

  const results = await Promise.allSettled(toClose.map((p) => closeAndRecord(p)));
  const closed = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.length - closed;
  const errors = results.flatMap((r, i) => (r.status === "rejected" ? [`${toClose[i].symbol}: ${(r.reason as Error).message}`] : []));

  return { evaluated: positions.length, closed, failed, errors, symbols: toClose.map((p) => p.symbol) };
}

/**
 * Scrive la riga sessions di oggi (storico reale del debriefing) — idempotente (ON CONFLICT
 * DO UPDATE), sicura da richiamare più volte nella stessa finestra di chiusura. Dal
 * 25/9/2026 (server/strategyAllocation.ts, niente più un'unica proposta esclusiva): strategy_id
 * è l'elenco delle strategie ammesse oggi unite da "+" (es. "pairs+vwap_reversion"), net/trades
 * sono la somma su quelle stesse, calcolati sul lab (todayResultFor, sedute *precedenti* a oggi
 * per l'ammissione — il risultato è identico a qualunque ora venga chiesto). Se nessuna
 * strategia è ammessa, non scrive nulla.
 */
export async function finalizeTodaySession(): Promise<{ skipped: true; reason: string } | { skipped: false; strategyId: string; net: number }> {
  const tradingDate = new Date().toISOString().slice(0, 10);
  const eligibility = await computeEligibility(tradingDate);
  const allocatedIds = eligibility.filter((e) => e.eligible).map((e) => e.strategyId);
  if (allocatedIds.length === 0) return { skipped: true, reason: "nessuna strategia ammessa oggi (vedi computeEligibility)" };

  const session = await fetchMarketSession(tradingDate);
  if (!session) return { skipped: true, reason: "nessuna sessione di mercato per oggi nel calendario" };

  const todayByStrategy = new Map<string, { net: number; trades: number }>();
  for (const id of STRATEGY_IDS) {
    todayByStrategy.set(id, await todayResultFor(id, session.openUtc));
  }
  const strategyIdLabel = allocatedIds.join("+");
  const allocatedToday = allocatedIds.reduce((s, id) => s + (todayByStrategy.get(id)?.net ?? 0), 0);
  const allocatedTrades = allocatedIds.reduce((s, id) => s + (todayByStrategy.get(id)?.trades ?? 0), 0);
  const excludedIds = STRATEGY_IDS.filter((id) => !allocatedIds.includes(id));
  const avgAllocated = allocatedToday / allocatedIds.length;
  const avgExcluded = excludedIds.length > 0 ? excludedIds.reduce((s, id) => s + (todayByStrategy.get(id)?.net ?? 0), 0) / excludedIds.length : avgAllocated;
  // % di quanto la media delle strategie ammesse si è discostata dalla media delle escluse, sul
  // capitale di un lab — non "lab vs conto reale" (vedi CLAUDE.md Prossimi passi #2).
  const deviationPct = ((avgAllocated - avgExcluded) / CAPITAL) * 100;

  const confirmRows = (await db()`
    SELECT confirmed_at FROM debrief_confirmations WHERE trading_date = ${tradingDate}
  `) as unknown as { confirmed_at: string }[];

  await db()`
    INSERT INTO sessions (trading_date, strategy_id, net, deviation_pct, trades, costs, confirmed_at)
    VALUES (${tradingDate}, ${strategyIdLabel}, ${allocatedToday}, ${deviationPct}, ${allocatedTrades}, 0, ${confirmRows[0]?.confirmed_at ?? null})
    ON CONFLICT (trading_date) DO UPDATE SET
      strategy_id = EXCLUDED.strategy_id, net = EXCLUDED.net, deviation_pct = EXCLUDED.deviation_pct,
      trades = EXCLUDED.trades, costs = EXCLUDED.costs, confirmed_at = EXCLUDED.confirmed_at
  `;

  return { skipped: false, strategyId: strategyIdLabel, net: allocatedToday };
}

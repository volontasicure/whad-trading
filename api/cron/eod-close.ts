import type { VercelRequest, VercelResponse } from "@vercel/node";
import { alpacaFetch } from "../../server/alpaca.js";
import { db } from "../../server/db.js";
import { fetchMarketSession } from "../../server/marketHours.js";
import { CAPITAL } from "../../server/pairsTrading.js";
import { todayResultFor, STRATEGY_IDS } from "../../server/debrief.js";
import { computeEligibility } from "../../server/strategyAllocation.js";

interface AlpacaClock {
  is_open: boolean;
  next_close: string;
}

interface AlpacaPosition {
  symbol: string;
  unrealized_pl: string;
  current_price: string;
}

interface RealOpenRow {
  symbol: string;
  pair_key: string | null;
}

interface AlpacaOrder {
  id: string;
  filled_avg_price: string | null;
}

const CLOSE_WINDOW_MINUTES = 20;

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

/** Chiude la posizione sul broker e registra l'uscita nelle righe real_positions aperte per quel simbolo (prima non veniva registrata: restavano "open" nel DB per sempre e il realized non entrava mai nei conteggi). */
async function closeAndRecord(p: AlpacaPosition): Promise<void> {
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
 * decidePairsEodCloses (server/pairsTrading.ts) — riprodotto qui sui dati Alpaca perché il
 * pairs trading reale non ha ancora avuto un giro di produzione per validarlo oltre il
 * backtest. Una posizione Alpaca senza riga corrispondente in real_positions (non dovrebbe
 * succedere) resta sulla vecchia regola prudente "chiudi solo se in utile".
 */
function decideRealEodCloses(positions: AlpacaPosition[], openRows: RealOpenRow[]): AlpacaPosition[] {
  const rowBySymbol = new Map(openRows.map((r) => [r.symbol, r]));
  const pairGroups = new Map<string, RealOpenRow[]>();
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
    if (legs.length < 2) continue; // gamba già orfana per altra causa, non compito di questo cron
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

/**
 * Scrive la riga sessions di oggi (storico reale del debriefing) — una volta sola, qui,
 * perché questo cron gira una volta al giorno vicino alla chiusura ed è il momento in cui
 * "il risultato reale di oggi" è finalmente conosciuto. Dal 25/9/2026 (server/strategyAllocation.ts,
 * niente più un'unica proposta esclusiva): strategy_id è l'elenco delle strategie ammesse oggi
 * unite da "+" (es. "pairs+vwap"), net/trades sono la somma su quelle stesse, calcolati sul lab
 * (todayResultFor, sedute *precedenti* a oggi per l'ammissione — il risultato è identico a
 * qualunque ora venga chiesto). Se nessuna strategia è ammessa, non scrive nulla — non esiste
 * un risultato sensato da segnare quel giorno. Best-effort: un problema qui non deve mai far
 * fallire la chiusura reale sopra, che è la responsabilità primaria di questo endpoint.
 */
async function finalizeTodaySession(): Promise<{ skipped: true; reason: string } | { skipped: false; strategyId: string; net: number }> {
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

/**
 * Chiude le posizioni reali a ridosso della chiusura di mercato secondo decideRealEodCloses
 * (singole sempre, pairs solo se in utile combinato — dettagli lì), e finalizza la riga
 * sessions del debriefing reale (finalizeTodaySession) — stesso cron
 * perché entrambe le cose hanno senso solo "a ridosso della chiusura", per non aggiungere
 * una funzione serverless in più (limite di 12 sul piano Hobby, già al tetto). Invocata da
 * Vercel Cron (vercel.json) una volta al giorno nei feriali.
 *
 * Limite noto: Vercel Cron su piano Hobby ammette un solo orario UTC fisso al giorno, ma la
 * chiusura NYSE (16:00 ET) cade a un'ora UTC diversa secondo l'ora legale USA (20:00 UTC in
 * EDT, 21:00 UTC in EST). Lo schedule qui sotto è tarato su EDT (la maggior parte dell'anno,
 * marzo-novembre): nei mesi EST il mercato risulterà già chiuso quando il cron parte e sia la
 * chiusura reale sia la scrittura di sessions verranno saltate quel giorno. Per coprire
 * entrambi i periodi servirebbe un cron più frequente (piano Pro) o uno scheduler
 * timezone-aware esterno — non ancora fatto.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = req.headers.authorization;
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: "Non autorizzato" });
    return;
  }

  try {
    const clock = await alpacaFetch<AlpacaClock>("/v2/clock");

    if (!clock.is_open) {
      res.status(200).json({ skipped: true, reason: "mercato chiuso", nextClose: clock.next_close });
      return;
    }

    const minutesToClose = (new Date(clock.next_close).getTime() - Date.now()) / 60_000;
    if (minutesToClose > CLOSE_WINDOW_MINUTES) {
      res.status(200).json({
        skipped: true,
        reason: `fuori dalla finestra di chiusura (mancano ${Math.round(minutesToClose)} min)`,
        nextClose: clock.next_close,
      });
      return;
    }

    const positions = await alpacaFetch<AlpacaPosition[]>("/v2/positions");
    const openRows = (await db()`
      SELECT symbol, pair_key FROM real_positions WHERE status = 'open'
    `) as unknown as RealOpenRow[];
    const toClose = decideRealEodCloses(positions, openRows);

    const results = await Promise.allSettled(toClose.map((p) => closeAndRecord(p)));
    const closed = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.length - closed;
    const errors = results.flatMap((r, i) =>
      r.status === "rejected" ? [`${toClose[i].symbol}: ${(r.reason as Error).message}`] : []
    );

    // Best-effort: un problema qui non deve far apparire fallita la chiusura reale sopra,
    // che è già andata a buon fine a questo punto.
    let session: Awaited<ReturnType<typeof finalizeTodaySession>> | { skipped: true; reason: string };
    try {
      session = await finalizeTodaySession();
    } catch (err) {
      session = { skipped: true, reason: `errore: ${(err as Error).message}` };
    }

    res.status(200).json({
      skipped: false,
      evaluated: positions.length,
      closed,
      failed,
      errors,
      symbols: toClose.map((p) => p.symbol),
      session,
    });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}

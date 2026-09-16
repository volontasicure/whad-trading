// Esecuzione reale sul conto Alpaca (ambiente paper): unico punto che invia ordini veri.
// Riusa le stesse decideEntries/decideExits pure dei tre lab (server/{orb,vwapReversion,
// pairsTrading}.ts, mai modificate) — cambia solo la sorgente dello stato (real_positions
// invece di lab_positions) e la size (sizeByConviction invece di CAPITAL/MAX_POSITIONS).
//
// Gate: nessun ordine senza una riga in debrief_confirmations per la data di oggi — stesso
// controllo umano che c'è già nella UI ("Conferma e attiva"), qui ha finalmente un effetto.
// Le uscite valgono per OGNI strategia con posizioni reali aperte (non solo quella scelta
// oggi): una posizione aperta ieri sotto ORB esce con le regole di ORB anche se oggi è stato
// scelto VWAP — stessa logica già in tick.ts per i lab.
//
// Guardrail: rifiuta di inviare ordini se l'ambiente Alpaca configurato non è "paper".

import { alpacaFetch, requireCredentials } from "./alpaca.js";
import { db } from "./db.js";
import { computeRanking } from "./debrief.js";
import { sizeByConviction, type SizingCandidate } from "./realSizing.js";
import { UNIVERSE_SYMBOLS } from "./universe.js";
import {
  MAX_POSITIONS as ORB_MAX_POSITIONS,
  STRATEGY_ID as ORB_STRATEGY_ID,
  decideEntries as decideOrbEntries,
  decideExits as decideOrbExits,
  type EntryInputs as OrbEntryInputs,
  type OpenPosition as OrbOpenPosition,
  type OpeningRange,
} from "./orb.js";
import {
  MAX_PAIRS,
  STRATEGY_ID as PAIRS_STRATEGY_ID,
  decideEntries as decidePairsEntries,
  decideExits as decidePairsExits,
  type OpenLeg,
  type PairStats,
} from "./pairsTrading.js";
import {
  MAX_POSITIONS as VWAP_MAX_POSITIONS,
  STRATEGY_ID as VWAP_STRATEGY_ID,
  decideEntries as decideVwapEntries,
  decideExits as decideVwapExits,
  type OpenPosition as VwapOpenPosition,
  type Snapshot as VwapSnapshot,
} from "./vwapReversion.js";

export interface RealPositionRow {
  id: number;
  strategy_id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  entry_price: number;
  entry_time: string;
  pair_key: string | null;
  stop_price: number | null;
  target_price: number | null;
}

export interface RealExecutionContext {
  tradingDate: string;
  now: Date;
  nearClose: boolean;
  prices: Record<string, number>;
  openingRanges: Record<string, OpeningRange>;
  orbAtr: Record<string, number>;
  /** Volumi delle barre a 5 min di oggi per simbolo, in ordine cronologico (solo il volume, per ricostruire avg/ultimo senza dipendere dal tipo barra privato di tick.ts). */
  sessionBarVolumes: Record<string, number[]>;
  vwapSnapshots: Record<string, VwapSnapshot>;
  vwapBars: Record<string, { t: string; c: number }[]>;
  pairStats: PairStats[];
  pairStatsByKey: Record<string, PairStats>;
  /** Righe già aperte in real_positions, lette una sola volta da tick.ts (stesso pattern di lab_positions). */
  openRows: RealPositionRow[];
}

export interface RealExecutionSummary {
  skipped: true;
  reason: string;
}

export interface RealExecutionResult {
  skipped: false;
  chosenStrategyId: string;
  exits: number;
  entries: number;
}

interface AlpacaOrderResponse {
  id: string;
  filled_avg_price: string | null;
  status: string;
}

interface AlpacaAccount {
  /** Capitale reale del conto (non buying_power: quello include il margine, tipicamente 4x
   *  l'equity su un conto Reg T — usarlo sizerebbe il conto reale a leva senza che nessuno
   *  l'abbia deciso, scoperto in dry-run prima del deploy: $100k equity, $400k buying_power). */
  equity: string;
}

/** Invia un ordine a mercato e prova a leggere il prezzo di fill reale (poche riprove brevi: i fill paper sono quasi sempre immediati, ma non garantiti nello stesso round-trip). */
async function submitMarketOrder(symbol: string, side: "buy" | "sell", qty: number): Promise<{ orderId: string; fillPrice: number | null }> {
  const order = await alpacaFetch<AlpacaOrderResponse>("/v2/orders", {
    method: "POST",
    body: JSON.stringify({ symbol, side, qty, type: "market", time_in_force: "day" }),
  });
  let fillPrice = order.filled_avg_price ? Number(order.filled_avg_price) : null;
  for (let i = 0; i < 3 && fillPrice == null; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const check = await alpacaFetch<AlpacaOrderResponse>(`/v2/orders/${order.id}`);
    if (check.filled_avg_price) fillPrice = Number(check.filled_avg_price);
  }
  return { orderId: order.id, fillPrice };
}

async function openRealPosition(params: {
  strategyId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  fallbackPrice: number;
  conviction: number;
  stopPrice: number | null;
  targetPrice: number | null;
  pairKeyVal: string | null;
  now: Date;
}): Promise<void> {
  const { orderId, fillPrice } = await submitMarketOrder(params.symbol, params.side === "LONG" ? "buy" : "sell", params.qty);
  const entryPrice = fillPrice ?? params.fallbackPrice;
  await db()`
    INSERT INTO real_positions
      (strategy_id, symbol, side, qty, entry_price, entry_time, status, stop_price, target_price, pair_key, conviction, broker_order_id)
    VALUES
      (${params.strategyId}, ${params.symbol}, ${params.side}, ${params.qty}, ${entryPrice}, ${params.now.toISOString()}, 'open',
       ${params.stopPrice}, ${params.targetPrice}, ${params.pairKeyVal}, ${params.conviction}, ${orderId})
  `;
}

async function closeRealPosition(params: {
  id: number;
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  entryPrice: number;
  fallbackPrice: number;
  reason: string;
  now: Date;
}): Promise<void> {
  const { orderId, fillPrice } = await submitMarketOrder(params.symbol, params.side === "LONG" ? "sell" : "buy", params.qty);
  const exitPrice = fillPrice ?? params.fallbackPrice;
  const dir = params.side === "LONG" ? 1 : -1;
  const realizedPnl = Math.round(params.qty * (exitPrice - params.entryPrice) * dir);
  await db()`
    UPDATE real_positions
    SET status = 'closed', exit_price = ${exitPrice}, exit_time = ${params.now.toISOString()},
        realized_pnl = ${realizedPnl}, exit_reason = ${params.reason}, broker_exit_order_id = ${orderId}
    WHERE id = ${params.id}
  `;
}

/** breakoutStrength di orb.ts, ricalcolato qui (mai esposto dal decideEntries di orb.ts): distanza dal bordo del range rotto, in % dell'ampiezza del range. */
function orbBreakoutStrength(entryPrice: number, side: "LONG" | "SHORT", range: OpeningRange): number {
  const width = range.high - range.low;
  if (width <= 0) return 0;
  return side === "LONG" ? (entryPrice - range.high) / width : (range.low - entryPrice) / width;
}

export async function runRealExecution(ctx: RealExecutionContext): Promise<RealExecutionSummary | RealExecutionResult> {
  const confirmRows = (await db()`
    SELECT confirmed_at FROM debrief_confirmations WHERE trading_date = ${ctx.tradingDate}
  `) as unknown as { confirmed_at: string }[];
  if (confirmRows.length === 0) return { skipped: true, reason: "debriefing non confermato oggi" };

  const creds = requireCredentials();
  if (creds.environment !== "paper") {
    return { skipped: true, reason: `ambiente Alpaca '${creds.environment}', non 'paper': esecuzione reale bloccata per sicurezza` };
  }

  const { entries: ranking, sessionsUsed } = await computeRanking(ctx.tradingDate);
  if (sessionsUsed === 0) return { skipped: true, reason: "nessuno storico di sedute precedenti ancora" };
  const chosenStrategyId = ranking[0].strategyId;

  const vwapOpen: VwapOpenPosition[] = ctx.openRows
    .filter((r) => r.strategy_id === VWAP_STRATEGY_ID)
    .map((r) => ({ id: r.id, symbol: r.symbol, side: r.side, qty: r.qty, entryPrice: r.entry_price, entryTime: r.entry_time }));
  const orbOpen: OrbOpenPosition[] = ctx.openRows
    .filter((r) => r.strategy_id === ORB_STRATEGY_ID)
    .map((r) => ({
      id: r.id,
      symbol: r.symbol,
      side: r.side,
      qty: r.qty,
      entryPrice: r.entry_price,
      stopPrice: r.stop_price ?? r.entry_price,
      targetPrice: r.target_price ?? r.entry_price,
    }));
  const pairsOpen: OpenLeg[] = ctx.openRows
    .filter((r) => r.strategy_id === PAIRS_STRATEGY_ID && r.pair_key)
    .map((r) => ({ id: r.id, pairKey: r.pair_key!, symbol: r.symbol, side: r.side, qty: r.qty, entryPrice: r.entry_price }));

  // --- Uscite: per ogni strategia con posizioni reali aperte, non solo quella scelta oggi ---
  const vwapExits = decideVwapExits(vwapOpen, ctx.vwapSnapshots, ctx.now);
  const orbExits = decideOrbExits(orbOpen, ctx.prices);
  const pairsExits = decidePairsExits(pairsOpen, ctx.prices, ctx.pairStatsByKey);

  let exitCount = 0;
  for (const exit of vwapExits) {
    await closeRealPosition({
      id: exit.position.id,
      symbol: exit.position.symbol,
      side: exit.position.side,
      qty: exit.position.qty,
      entryPrice: exit.position.entryPrice,
      fallbackPrice: exit.exitPrice,
      reason: exit.reason,
      now: ctx.now,
    });
    exitCount++;
  }
  for (const exit of orbExits) {
    await closeRealPosition({
      id: exit.position.id,
      symbol: exit.position.symbol,
      side: exit.position.side,
      qty: exit.position.qty,
      entryPrice: exit.position.entryPrice,
      fallbackPrice: exit.exitPrice,
      reason: exit.reason,
      now: ctx.now,
    });
    exitCount++;
  }
  for (const exit of pairsExits) {
    for (const legId of exit.legIds) {
      const leg = pairsOpen.find((l) => l.id === legId);
      const price = leg ? ctx.prices[leg.symbol] : undefined;
      if (!leg || price == null) continue;
      await closeRealPosition({
        id: leg.id,
        symbol: leg.symbol,
        side: leg.side,
        qty: leg.qty,
        entryPrice: leg.entryPrice,
        fallbackPrice: price,
        reason: exit.reason,
        now: ctx.now,
      });
      exitCount++;
    }
  }

  // --- Ingressi: solo per la strategia scelta oggi, solo se non siamo a ridosso della chiusura ---
  let entryCount = 0;
  if (!ctx.nearClose) {
    const account = await alpacaFetch<AlpacaAccount>("/v2/account");
    const capital = Number(account.equity);

    if (chosenStrategyId === VWAP_STRATEGY_ID) {
      const stillOpen = new Set(vwapOpen.filter((p) => !vwapExits.some((e) => e.position.id === p.id)).map((p) => p.symbol));
      const freeSlots = VWAP_MAX_POSITIONS - stillOpen.size;
      const candidates = decideVwapEntries(UNIVERSE_SYMBOLS, stillOpen, ctx.vwapSnapshots, ctx.vwapBars, freeSlots);
      const sizingInput: SizingCandidate[] = candidates.map((c) => ({ symbol: c.symbol, price: c.entryPrice, conviction: Math.abs(c.distancePct) }));
      const sized = sizeByConviction(sizingInput, capital, VWAP_MAX_POSITIONS);
      for (const c of candidates) {
        const qty = sized[c.symbol];
        if (!qty) continue;
        await openRealPosition({
          strategyId: VWAP_STRATEGY_ID,
          symbol: c.symbol,
          side: c.side,
          qty,
          fallbackPrice: c.entryPrice,
          conviction: Math.abs(c.distancePct),
          stopPrice: null,
          targetPrice: null,
          pairKeyVal: null,
          now: ctx.now,
        });
        entryCount++;
      }
    } else if (chosenStrategyId === ORB_STRATEGY_ID) {
      const stillOpen = new Set(orbOpen.filter((p) => !orbExits.some((e) => e.position.id === p.id)).map((p) => p.symbol));
      const freeSlots = ORB_MAX_POSITIONS - stillOpen.size;
      const inputs: Record<string, OrbEntryInputs> = {};
      for (const symbol of UNIVERSE_SYMBOLS) {
        const range = ctx.openingRanges[symbol];
        const atr = ctx.orbAtr[symbol];
        const volumes = ctx.sessionBarVolumes[symbol] ?? [];
        const price = ctx.prices[symbol];
        if (!range || atr == null || volumes.length === 0 || price == null) continue;
        const avgVol = volumes.reduce((s, v) => s + v, 0) / volumes.length;
        inputs[symbol] = { price, openingRange: range, atrPct: atr, avgBarVolume: avgVol, latestBarVolume: volumes[volumes.length - 1] };
      }
      const candidates = decideOrbEntries(UNIVERSE_SYMBOLS, stillOpen, inputs, freeSlots);
      const sizingInput: SizingCandidate[] = candidates.map((c) => {
        const range = ctx.openingRanges[c.symbol];
        const conviction = range ? Math.abs(orbBreakoutStrength(c.entryPrice, c.side, range)) : 0;
        return { symbol: c.symbol, price: c.entryPrice, conviction };
      });
      const sized = sizeByConviction(sizingInput, capital, ORB_MAX_POSITIONS);
      for (const c of candidates) {
        const qty = sized[c.symbol];
        if (!qty) continue;
        const range = ctx.openingRanges[c.symbol];
        await openRealPosition({
          strategyId: ORB_STRATEGY_ID,
          symbol: c.symbol,
          side: c.side,
          qty,
          fallbackPrice: c.entryPrice,
          conviction: range ? Math.abs(orbBreakoutStrength(c.entryPrice, c.side, range)) : 0,
          stopPrice: c.stopPrice,
          targetPrice: c.targetPrice,
          pairKeyVal: null,
          now: ctx.now,
        });
        entryCount++;
      }
    } else if (chosenStrategyId === PAIRS_STRATEGY_ID) {
      const stillOpenKeys = new Set(pairsOpen.filter((leg) => !pairsExits.some((e) => e.legIds.includes(leg.id))).map((leg) => leg.pairKey));
      const freeSlots = MAX_PAIRS - stillOpenKeys.size;
      const candidates = decidePairsEntries(ctx.pairStats, stillOpenKeys, ctx.prices, freeSlots);
      // Una coppia = un candidato di sizing, prezzo fittizio 1 -> la qty restituita è
      // direttamente il budget in dollari per la coppia, diviso poi a metà tra le due gambe
      // (stesso schema "capitale diviso a metà" di pairsTrading.ts, solo con budget variabile
      // invece di CAPITAL/MAX_PAIRS fisso).
      const sizingInput: SizingCandidate[] = candidates.map((c) => ({ symbol: c.pairKey, price: 1, conviction: Math.abs(c.z) }));
      const sizedDollars = sizeByConviction(sizingInput, capital, MAX_PAIRS);
      for (const c of candidates) {
        const dollars = sizedDollars[c.pairKey];
        if (!dollars) continue;
        const dollarsPerLeg = dollars / 2;
        for (const leg of c.legs) {
          const qty = Math.max(1, Math.floor(dollarsPerLeg / leg.entryPrice));
          await openRealPosition({
            strategyId: PAIRS_STRATEGY_ID,
            symbol: leg.symbol,
            side: leg.side,
            qty,
            fallbackPrice: leg.entryPrice,
            conviction: Math.abs(c.z),
            stopPrice: null,
            targetPrice: null,
            pairKeyVal: c.pairKey,
            now: ctx.now,
          });
          entryCount++;
        }
      }
    }
  }

  return { skipped: false, chosenStrategyId, exits: exitCount, entries: entryCount };
}

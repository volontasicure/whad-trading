// Esecuzione reale sul conto Alpaca (ambiente paper): unico punto che invia ordini veri.
// Riusa le stesse decideEntries/decideExits pure dei tre lab (server/{orb,vwapReversion,
// pairsTrading}.ts, mai modificate) — cambia solo la sorgente dello stato (real_positions
// invece di lab_positions) e la size (sizeByConviction invece di CAPITAL/MAX_POSITIONS).
//
// Gate: nessun ordine senza una riga in debrief_confirmations per la data di oggi — stesso
// controllo umano che c'è già nella UI ("Conferma e attiva"), qui ha finalmente un effetto.
// Le uscite valgono per OGNI strategia con posizioni reali aperte (indipendentemente dal peso
// di oggi): una posizione aperta ieri sotto ORB esce con le regole di ORB anche se oggi ORB ha
// peso zero — stessa logica già in tick.ts per i lab.
//
// Allocazione, dal 25/9/2026 (server/strategyAllocation.ts): il capitale reale non va più a
// un'unica strategia scelta al mattino ("vincitore prende tutto"), ma è diviso tra tutte le
// strategie ammesse — storico minimo in paper + drawdown recente sotto soglia — pesate equal-
// weight. Ogni strategia ammessa apre ingressi nel proprio budget (capital × il suo peso),
// mai nell'intero capitale. Vedi CLAUDE.md per il ragionamento.
//
// Guardrail: rifiuta di inviare ordini se l'ambiente Alpaca configurato non è "paper".

import { alpacaFetch, requireCredentials } from "./alpaca.js";
import { db } from "./db.js";
import { computeEligibility, computeWeights } from "./strategyAllocation.js";
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
  type TrendContext as VwapTrendContext,
} from "./vwapReversion.js";

/** Perdita giornaliera (% dell'equity di ieri) oltre la quale il reale smette di aprire nuove posizioni. Aggiunto il 19/9/2026: il 15/9 e il 16/9 avrebbero perso circa 1.000 invece di 1.378 e 2.057. */
export const MAX_DAILY_LOSS_PCT = 1.0;

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
  vwapTrend: Record<string, VwapTrendContext>;
  /** Volumi delle barre a 5 min di oggi per simbolo, in ordine cronologico (solo il volume, per ricostruire avg/ultimo senza dipendere dal tipo barra privato di tick.ts). */
  sessionBarVolumes: Record<string, number[]>;
  vwapSnapshots: Record<string, VwapSnapshot>;
  vwapBars: Record<string, { t: string; c: number }[]>;
  pairStats: PairStats[];
  pairStatsByKey: Record<string, PairStats>;
  /** Coppie uscite in stop oggi (raffreddamento post-stop, stesso stato già calcolato e
   *  cachato da tick.ts per il lab in lab_state — passato qui invece di ricalcolato, per non
   *  duplicare la query). Prima del 18/9/2026 questo controllo esisteva solo lato lab: il
   *  conto reale poteva ririentrare senza limiti su una coppia appena stoppata. */
  stoppedPairsToday: Set<string>;
  /** Righe già aperte in real_positions, lette una sola volta da tick.ts (stesso pattern di lab_positions). */
  openRows: RealPositionRow[];
}

export interface RealExecutionSummary {
  skipped: true;
  reason: string;
}

export interface RealExecutionResult {
  skipped: false;
  /** Vero se i nuovi ingressi sono stati bloccati dal limite di perdita giornaliero. */
  haltedByDailyLoss?: boolean;
  /** Strategie ammesse oggi (peso > 0) — vuoto se nessuna supera i gate di server/strategyAllocation.ts. */
  allocatedStrategies: string[];
  exits: number;
  entries: number;
}

interface AlpacaOrderResponse {
  id: string;
  filled_avg_price: string | null;
  status: string;
}

interface AlpacaPosition {
  qty: string;
}

interface AlpacaClosedOrder {
  id: string;
  type: string;
  status: string;
  filled_avg_price: string | null;
}

interface AlpacaAccount {
  /** Capitale reale del conto (non buying_power: quello include il margine, tipicamente 4x
   *  l'equity su un conto Reg T — usarlo sizerebbe il conto reale a leva senza che nessuno
   *  l'abbia deciso, scoperto in dry-run prima del deploy: $100k equity, $400k buying_power). */
  equity: string;
  /** Equity alla chiusura precedente: base per la perdita giornaliera. */
  last_equity: string;
}

/** Alpaca rifiuta stop/limit price con più di 2 decimali sui titoli sopra 1$. */
function roundToCent(price: number): number {
  return Math.round(price * 100) / 100;
}

/** Poche riprove brevi per leggere il prezzo di fill reale: i fill paper sono quasi sempre immediati, ma non garantiti nello stesso round-trip. Condivisa tra ordini a mercato semplici e bracket. */
async function pollFillPrice(orderId: string, initial: number | null): Promise<number | null> {
  let fillPrice = initial;
  for (let i = 0; i < 3 && fillPrice == null; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const check = await alpacaFetch<AlpacaOrderResponse>(`/v2/orders/${orderId}`);
    if (check.filled_avg_price) fillPrice = Number(check.filled_avg_price);
  }
  return fillPrice;
}

/** Invia un ordine a mercato semplice (VWAP, pairs trading: uscite dinamiche, non esprimibili come stop/target fissi). */
async function submitMarketOrder(symbol: string, side: "buy" | "sell", qty: number): Promise<{ orderId: string; fillPrice: number | null }> {
  const order = await alpacaFetch<AlpacaOrderResponse>("/v2/orders", {
    method: "POST",
    body: JSON.stringify({ symbol, side, qty, type: "market", time_in_force: "day" }),
  });
  const fillPrice = await pollFillPrice(order.id, order.filled_avg_price ? Number(order.filled_avg_price) : null);
  return { orderId: order.id, fillPrice };
}

/** Ingresso a mercato con stop-loss e take-profit nativi collegati in OCO (order_class "bracket"),
 *  gestiti dal broker in tempo reale invece che dal polling a 5 minuti di decideOrbExits. Solo per
 *  ORB: è l'unica strategia con stop/target fissi calcolati una volta sola all'ingresso — VWAP e
 *  pairs trading hanno uscite dinamiche (ritorno al VWAP, z-score), non esprimibili come un singolo
 *  prezzo di trigger. */
async function submitBracketOrder(
  symbol: string,
  side: "buy" | "sell",
  qty: number,
  stopPrice: number,
  targetPrice: number
): Promise<{ orderId: string; fillPrice: number | null }> {
  const order = await alpacaFetch<AlpacaOrderResponse>("/v2/orders", {
    method: "POST",
    body: JSON.stringify({
      symbol,
      side,
      qty,
      type: "market",
      time_in_force: "day",
      order_class: "bracket",
      take_profit: { limit_price: roundToCent(targetPrice) },
      stop_loss: { stop_price: roundToCent(stopPrice) },
    }),
  });
  const fillPrice = await pollFillPrice(order.id, order.filled_avg_price ? Number(order.filled_avg_price) : null);
  return { orderId: order.id, fillPrice };
}

/** Posizione aperta sul broker per un simbolo, o null se non esiste (404) — usato dalla riconciliazione per capire se un bracket ha già chiuso una posizione ORB prima di questo tick. Solo un vero 404 conta come "chiusa": qualunque altro errore va propagato, mai interpretato come chiusura silenziosa. */
async function fetchOpenPositionQty(symbol: string): Promise<number | null> {
  const creds = requireCredentials();
  const res = await fetch(`${creds.baseUrl}/v2/positions/${symbol}`, {
    headers: { "APCA-API-KEY-ID": creds.keyId, "APCA-API-SECRET-KEY": creds.secretKey },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Alpaca GET /v2/positions/${symbol} -> ${res.status} ${body}`);
  }
  const data = (await res.json()) as AlpacaPosition;
  return Number(data.qty);
}

interface AlpacaAsset {
  shortable: boolean;
  easy_to_borrow: boolean;
}

/** Vero se il titolo è shortabile e facilmente reperibile in prestito sul broker — evita ordini
 *  short che Alpaca rifiuterebbe o che accumulano costi di prestito su titoli hard-to-borrow.
 *  Controllo solo lato esecuzione reale: i lab restano simulati, non hanno questo vincolo. */
async function isShortable(symbol: string): Promise<boolean> {
  const asset = await alpacaFetch<AlpacaAsset>(`/v2/assets/${symbol}`);
  return asset.shortable && asset.easy_to_borrow;
}

/** Scarta i candidati che aprirebbero (anche solo su una gamba, per i pairs) una posizione
 *  SHORT su un titolo non shortabile/hard-to-borrow. Per i pairs, se una gamba non passa il
 *  controllo si scarta l'intera coppia: mai aprire una gamba orfana di proposito. Nota: il
 *  filtro è applicato dopo che decideEntries ha già scelto e ordinato i candidati per i
 *  freeSlots disponibili — in una giornata con titoli hard-to-borrow, l'esecuzione reale può
 *  usare meno slot del lab corrispondente quel giorno, non li rimpiazza con il candidato successivo. */
async function filterShortableCandidates<T>(
  candidates: T[],
  sidesOf: (c: T) => { symbol: string; side: "LONG" | "SHORT" }[]
): Promise<T[]> {
  const checked = await Promise.all(
    candidates.map(async (c) => {
      const shortSymbols = sidesOf(c)
        .filter((s) => s.side === "SHORT")
        .map((s) => s.symbol);
      if (shortSymbols.length === 0) return { c, ok: true };
      const results = await Promise.all(shortSymbols.map((symbol) => isShortable(symbol)));
      return { c, ok: results.every(Boolean) };
    })
  );
  return checked.filter((x) => x.ok).map((x) => x.c);
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
  const brokerSide = params.side === "LONG" ? "buy" : "sell";
  const useBracket = params.strategyId === ORB_STRATEGY_ID && params.stopPrice != null && params.targetPrice != null;
  const { orderId, fillPrice } = useBracket
    ? await submitBracketOrder(params.symbol, brokerSide, params.qty, params.stopPrice!, params.targetPrice!)
    : await submitMarketOrder(params.symbol, brokerSide, params.qty);
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

/** Registra una chiusura già eseguita dal broker (gamba del bracket già filled) — nessun nuovo ordine inviato, a differenza di closeRealPosition. */
async function recordBrokerClose(params: {
  id: number;
  side: "LONG" | "SHORT";
  qty: number;
  entryPrice: number;
  exitPrice: number;
  reason: string;
  brokerOrderId: string;
  now: Date;
}): Promise<void> {
  const dir = params.side === "LONG" ? 1 : -1;
  const realizedPnl = Math.round(params.qty * (params.exitPrice - params.entryPrice) * dir);
  await db()`
    UPDATE real_positions
    SET status = 'closed', exit_price = ${params.exitPrice}, exit_time = ${params.now.toISOString()},
        realized_pnl = ${realizedPnl}, exit_reason = ${params.reason}, broker_exit_order_id = ${params.brokerOrderId}
    WHERE id = ${params.id}
  `;
}

/** Per ogni posizione ORB reale aperta, controlla se il bracket order l'ha già chiusa sul broker
 *  prima di questo tick (protezione in tempo reale, non al prossimo giro di polling). Se sì,
 *  registra la chiusura con i dati reali del fill e la esclude dal set restituito, così
 *  decideOrbExits non la rivede più — evita una doppia chiusura (un secondo ordine su una
 *  posizione che il broker ha già azzerato). Se il 404 su /v2/positions arriva ma l'ordine di
 *  chiusura non si trova ancora (lag di propagazione), la posizione non viene toccata in questo
 *  tick: niente stillOpen (decideOrbExits non le manderebbe un ordine a vuoto) e niente chiusura
 *  senza dati reali — si riprova al tick successivo. */
async function reconcileOrbBrokerCloses(
  openPositions: OrbOpenPosition[],
  now: Date
): Promise<{ stillOpen: OrbOpenPosition[]; reconciledCount: number }> {
  const stillOpen: OrbOpenPosition[] = [];
  let reconciledCount = 0;
  for (const pos of openPositions) {
    const qty = await fetchOpenPositionQty(pos.symbol);
    if (qty != null) {
      stillOpen.push(pos);
      continue;
    }
    const closedOrders = await alpacaFetch<AlpacaClosedOrder[]>(
      `/v2/orders?status=closed&symbols=${pos.symbol}&direction=desc&limit=5`
    );
    const fill = closedOrders.find((o) => o.status === "filled" && (o.type === "stop" || o.type === "limit"));
    if (!fill || fill.filled_avg_price == null) continue; // in attesa che l'ordine risulti propagato, riprova al prossimo tick

    await recordBrokerClose({
      id: pos.id,
      side: pos.side,
      qty: pos.qty,
      entryPrice: pos.entryPrice,
      exitPrice: Number(fill.filled_avg_price),
      reason: fill.type === "stop" ? "stop" : "target",
      brokerOrderId: fill.id,
      now,
    });
    reconciledCount++;
  }
  return { stillOpen, reconciledCount };
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

  const eligibility = await computeEligibility(ctx.tradingDate);
  const weights = computeWeights(eligibility);
  const allocatedStrategies = eligibility.filter((e) => e.eligible).map((e) => e.strategyId);

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

  // Riconciliazione ORB: prima di controllare stop/target a prezzo, verifica se un bracket
  // order ha già chiuso una posizione sul broker tra un tick e l'altro (protezione in tempo
  // reale). Le posizioni già chiuse così non entrano più in decideOrbExits, niente doppio ordine.
  const { stillOpen: orbOpenReconciled, reconciledCount: orbReconciledCloses } = await reconcileOrbBrokerCloses(orbOpen, ctx.now);

  // --- Uscite: per ogni strategia con posizioni reali aperte, non solo quella scelta oggi ---
  const vwapExits = decideVwapExits(vwapOpen, ctx.vwapSnapshots, ctx.now);
  const orbExits = decideOrbExits(orbOpenReconciled, ctx.prices);
  const pairsExits = decidePairsExits(pairsOpen, ctx.prices, ctx.pairStatsByKey);

  let exitCount = orbReconciledCloses;
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

  // --- Ingressi: per ogni strategia ammessa oggi (peso > 0), solo se non siamo a ridosso della chiusura ---
  let entryCount = 0;
  let haltedByDailyLoss = false;
  if (!ctx.nearClose) {
    const account = await alpacaFetch<AlpacaAccount>("/v2/account");
    const capital = Number(account.equity);
    // Limite di perdita giornaliero: oltre -MAX_DAILY_LOSS_PCT dell'equity di ieri (realized +
    // unrealized) niente nuovi ingressi; le uscite restano gestite come sempre.
    const lastEquity = Number(account.last_equity);
    if (lastEquity > 0 && (capital - lastEquity) / lastEquity <= -MAX_DAILY_LOSS_PCT / 100) haltedByDailyLoss = true;

    // Ogni strategia ammessa (peso > 0) apre ingressi nel proprio budget (capital × il suo
    // peso) — indipendenti tra loro, non più un unico ramo esclusivo. Se una strategia ha peso
    // zero (esclusa dai gate), il suo blocco è saltato: nessun nuovo ingresso, ma le sue
    // posizioni già aperte restano gestite normalmente in uscita (sopra).
    if (haltedByDailyLoss) {
      // nessun nuovo ingresso: limite di perdita giornaliero raggiunto
    } else {
      if (weights[VWAP_STRATEGY_ID] > 0) {
        const vwapCapital = capital * weights[VWAP_STRATEGY_ID];
        const stillOpen = new Set(vwapOpen.filter((p) => !vwapExits.some((e) => e.position.id === p.id)).map((p) => p.symbol));
        const freeSlots = VWAP_MAX_POSITIONS - stillOpen.size;
        // ctx.vwapTrend disponibile ma NON passato qui apposta — stesso interruttore spento di
        // api/cron/tick.ts, vedi il commento lì.
        const rawCandidates = decideVwapEntries(UNIVERSE_SYMBOLS, stillOpen, ctx.vwapSnapshots, ctx.vwapBars, freeSlots);
        const candidates = await filterShortableCandidates(rawCandidates, (c) => [{ symbol: c.symbol, side: c.side }]);
        const sizingInput: SizingCandidate[] = candidates.map((c) => ({ symbol: c.symbol, price: c.entryPrice, conviction: Math.abs(c.distancePct) }));
        const sized = sizeByConviction(sizingInput, vwapCapital, VWAP_MAX_POSITIONS);
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
      }

      if (weights[ORB_STRATEGY_ID] > 0) {
        const orbCapital = capital * weights[ORB_STRATEGY_ID];
        const stillOpen = new Set(orbOpenReconciled.filter((p) => !orbExits.some((e) => e.position.id === p.id)).map((p) => p.symbol));
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
        const rawCandidates = decideOrbEntries(UNIVERSE_SYMBOLS, stillOpen, inputs, freeSlots);
        const candidates = await filterShortableCandidates(rawCandidates, (c) => [{ symbol: c.symbol, side: c.side }]);
        const sizingInput: SizingCandidate[] = candidates.map((c) => {
          const range = ctx.openingRanges[c.symbol];
          const conviction = range ? Math.abs(orbBreakoutStrength(c.entryPrice, c.side, range)) : 0;
          return { symbol: c.symbol, price: c.entryPrice, conviction };
        });
        const sized = sizeByConviction(sizingInput, orbCapital, ORB_MAX_POSITIONS);
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
      }

      if (weights[PAIRS_STRATEGY_ID] > 0) {
        const pairsCapital = capital * weights[PAIRS_STRATEGY_ID];
        const stillOpenKeys = new Set(pairsOpen.filter((leg) => !pairsExits.some((e) => e.legIds.includes(leg.id))).map((leg) => leg.pairKey));
        const freeSlots = MAX_PAIRS - stillOpenKeys.size;
        const pairsExcludedKeys = new Set([...stillOpenKeys, ...ctx.stoppedPairsToday]);
        const rawCandidates = decidePairsEntries(ctx.pairStats, pairsExcludedKeys, ctx.prices, freeSlots);
        const candidates = await filterShortableCandidates(rawCandidates, (c) => c.legs);
        // Una coppia = un candidato di sizing, prezzo fittizio 1 -> la qty restituita è
        // direttamente il budget in dollari per la coppia, diviso poi a metà tra le due gambe
        // (stesso schema "capitale diviso a metà" di pairsTrading.ts, solo con budget variabile
        // invece di CAPITAL/MAX_PAIRS fisso — qui il budget è già la sola quota pairs).
        const sizingInput: SizingCandidate[] = candidates.map((c) => ({ symbol: c.pairKey, price: 1, conviction: Math.abs(c.z) }));
        const sizedDollars = sizeByConviction(sizingInput, pairsCapital, MAX_PAIRS);
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
  }

  return { skipped: false, allocatedStrategies, exits: exitCount, entries: entryCount, haltedByDailyLoss };
}

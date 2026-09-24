// Backtest locale: rigioca N giorni di mercato reali attraverso le stesse funzioni pure
// di server/{orb,vwapReversion,pairsTrading,labEod}.ts, tutto in memoria, senza toccare
// lab_positions/lab_state di produzione. Ricostruisce lo strumento descritto nel CLAUDE.md
// del progetto ("Come validare prima di ogni mercato aperto") — rimosso in origine per
// restare sotto il limite di 12 funzioni Vercel, qui è uno script locale (non deployato,
// non conta nel budget) via `npx tsx scripts/backtest.ts [giorni]`.
//
// Usa daily_bars già persistito in DB per ATR/pairs trading, e scarica al volo da Alpaca
// solo le barre a 5 minuti dei giorni da rigiocare (session_bars storico non esiste ancora,
// il tick ha iniziato ad accumularlo solo da questa sessione in poi).

import { readFileSync } from "node:fs";
import path from "node:path";
import { neon } from "@neondatabase/serverless";
import { alpacaFetch, alpacaDataFetch } from "../server/alpaca.js";
import { fetchMarketSession } from "../server/marketHours.js";
import { UNIVERSE_SYMBOLS } from "../server/universe.js";
import {
  MAX_POSITIONS as ORB_MAX_POSITIONS,
  computeATRPct,
  computeOpeningRange,
  decideEntries as decideOrbEntries,
  decideExits as decideOrbExits,
  type DailyBar as OrbDailyBar,
  type EntryInputs as OrbEntryInputs,
  type OpenPosition as OrbOpenPosition,
  type OpeningRange,
} from "../server/orb.js";
import {
  MAX_POSITIONS as VWAP_MAX_POSITIONS,
  TREND_FILTER_DAYS as VWAP_TREND_FILTER_DAYS,
  STOP_LOSS_PCT as VWAP_STOP_LOSS_PCT,
  decideEntries as decideVwapEntries,
  decideExits as decideVwapExits,
  type Bar as VwapBar,
  type OpenPosition as VwapOpenPosition,
  type Snapshot as VwapSnapshot,
  type TrendContext as VwapTrendContext,
} from "../server/vwapReversion.js";
import { computeSMA, computeTrendEfficiency } from "../server/technicalIndicators.js";
import {
  MAX_PAIRS,
  decideEntries as decidePairsEntries,
  decideExits as decidePairsExits,
  decidePairsEodCloses,
  pairKey,
  selectPairs,
  statsForPair,
  type OpenLeg,
  type PairStats,
} from "../server/pairsTrading.js";
import { decideLabEodCloses, type LabOpenRow } from "../server/labEod.js";

function loadEnvLocal() {
  const p = path.resolve(process.cwd(), ".env.local");
  let content: string;
  try {
    content = readFileSync(p, "utf8");
  } catch {
    return;
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvLocal();

const POSTGRES_URL = process.env.POSTGRES_URL;
if (!POSTGRES_URL) {
  console.error("POSTGRES_URL mancante in .env.local.");
  process.exit(1);
}
const sql = neon(POSTGRES_URL);

// Con ORB_INTRABAR=1 gli stop/target ORB sono valutati sul massimo/minimo di ogni barra a 5
// minuti invece che sulla sola chiusura: simula gli stop nativi del broker (bracket order,
// attivi dal 18/9/2026 sul conto reale), che scattano su qualunque scambio, non solo sul
// prezzo campionato ogni 5 minuti come fa il lab. Stesso barra: se stop e target cadono nella
// stessa barra si assume lo stop (ipotesi prudente); gap oltre lo stop = fill all'apertura.
const ORB_INTRABAR = process.env.ORB_INTRABAR === '1';
if (ORB_INTRABAR) console.log("ORB_INTRABAR attivo: stop/target ORB su massimo/minimo delle barre\n");

// Varianti da valutare al checkpoint del 21/9/2026 (nessuna è attiva in produzione):
// EXP_ORB_STOP_MULT=0.75 sposta lo stop ORB a 0,75× l'ampiezza del range (default 0,5, target invariato);
// EXP_PAIRS_DELAY_MIN=20 vieta nuovi ingressi pairs nei primi 20 minuti di seduta.
const EXP_ORB_STOP_MULT = process.env.EXP_ORB_STOP_MULT ? Number(process.env.EXP_ORB_STOP_MULT) : null;
const EXP_PAIRS_DELAY_MIN = process.env.EXP_PAIRS_DELAY_MIN ? Number(process.env.EXP_PAIRS_DELAY_MIN) : 0;
if (EXP_ORB_STOP_MULT != null) console.log(`EXP_ORB_STOP_MULT=${EXP_ORB_STOP_MULT}`);
if (EXP_PAIRS_DELAY_MIN > 0) console.log(`EXP_PAIRS_DELAY_MIN=${EXP_PAIRS_DELAY_MIN}`);

// Varianti VWAP da valutare dopo la seduta del 21/9/2026 (META shortata 6 volte, 5 uscite in perdita,
// stesso schema di BA il 16/9). Nessuna è attiva in produzione:
// EXP_VWAP_TREND=0|1 forza il filtro di trend spento/acceso. Se non impostata resta il comportamento storico
//   dello script (acceso), mentre la produzione lo ha SPENTO: per confrontare con la produzione usare 0.
// EXP_VWAP_COOLDOWN_STOP=1 dopo uno stop_loss su un simbolo, niente altri ingressi VWAP su quel simbolo nello stesso giorno;
// EXP_VWAP_MAX_ENTRIES_PER_SYMBOL=N al massimo N ingressi VWAP per simbolo al giorno.
const EXP_VWAP_TREND = process.env.EXP_VWAP_TREND === undefined ? null : process.env.EXP_VWAP_TREND === '1';
const EXP_VWAP_COOLDOWN_STOP = process.env.EXP_VWAP_COOLDOWN_STOP === '1';
const EXP_VWAP_MAX_ENTRIES = process.env.EXP_VWAP_MAX_ENTRIES_PER_SYMBOL ? Number(process.env.EXP_VWAP_MAX_ENTRIES_PER_SYMBOL) : 0;
console.log(
  `VWAP: filtro trend=${EXP_VWAP_TREND === null ? "acceso (default storico)" : EXP_VWAP_TREND ? "acceso" : "spento"}, ` +
    `cooldown post-stop=${EXP_VWAP_COOLDOWN_STOP ? "si" : "no"}, max ingressi/simbolo=${EXP_VWAP_MAX_ENTRIES || "illimitati"}`
);

// Varianti ORB valutate dopo la seduta whipsaw del 24/9/2026 (13 ingressi, 12 stop, 1 target,
// -1.154 nel lab — record negativo — con TXN e GE, i range più stretti in % del prezzo,
// rientrati 3-4 volte ciascuno sullo stesso livello). Nessuna è attiva in produzione:
// EXP_ORB_MIN_RANGE_PCT=0.6 scarta la rottura se il range di apertura è sotto questa % del prezzo
//   (stop troppo stretto rispetto al rumore normale a 5 minuti);
// EXP_ORB_CONFIRM_BARS=2 richiede che il prezzo resti oltre il range per N barre consecutive
//   prima di entrare, invece di 1 sola barra;
// EXP_ORB_MAX_ENTRIES_PER_SYMBOL=2 limita i tentativi per simbolo per giorno (diverso dal
//   cooldown totale già bocciato il 18/9 — qui i rientri restano permessi, solo non illimitati).
const EXP_ORB_MIN_RANGE_PCT = process.env.EXP_ORB_MIN_RANGE_PCT ? Number(process.env.EXP_ORB_MIN_RANGE_PCT) : 0;
const EXP_ORB_CONFIRM_BARS = process.env.EXP_ORB_CONFIRM_BARS ? Number(process.env.EXP_ORB_CONFIRM_BARS) : 1;
const EXP_ORB_MAX_ENTRIES = process.env.EXP_ORB_MAX_ENTRIES_PER_SYMBOL ? Number(process.env.EXP_ORB_MAX_ENTRIES_PER_SYMBOL) : 0;
console.log(
  `ORB: range minimo=${EXP_ORB_MIN_RANGE_PCT > 0 ? EXP_ORB_MIN_RANGE_PCT + "%" : "nessuno"}, ` +
    `conferma barre=${EXP_ORB_CONFIRM_BARS}, max ingressi/simbolo=${EXP_ORB_MAX_ENTRIES || "illimitati"}`
);

// Variante VWAP valutata dopo l'analisi del 24/9/2026 sullo storico completo: il bucket
// stop_loss (29 trade su tutta la storia, netto -2.674, media -92/trade) è di gran lunga il
// più grande fattore di perdita del VWAP, mentre max_hold (43 trade, +692) è lievemente
// positivo — segno che il segnale d'ingresso ha un margine, ma lo stop attuale (0,6%) lo
// taglia spesso prima che possa esprimersi. Non attiva in produzione.
const EXP_VWAP_STOP_PCT = process.env.EXP_VWAP_STOP_PCT ? Number(process.env.EXP_VWAP_STOP_PCT) : null;
if (EXP_VWAP_STOP_PCT != null) console.log(`VWAP: stop override=${EXP_VWAP_STOP_PCT}% (produzione: ${VWAP_STOP_LOSS_PCT}%)`);

// Altri parametri valutati il 24/9/2026, ognuno su un asse diverso da quelli già bocciati
// stasera (range minimo/conferma barre/tetto ingressi per ORB, stop per VWAP). Nessuno attivo
// in produzione. EXP_ORB_RANGE_MINUTES: ampiezza del range di apertura (default 15 min) — un
// range più largo dovrebbe essere meno rumoroso della sola soglia minima già bocciata.
// EXP_ORB_VOLUME_MULT: soglia di conferma volume (default 1,8×) — asse diverso dall'ampiezza
// del range. EXP_VWAP_MAX_HOLD_MIN: durata massima in posizione (default 45 min) — il bucket
// max_hold è l'unico lievemente positivo nello storico (+692 su 43 trade), un tempo più lungo
// potrebbe lasciarlo esprimere di più. EXP_VWAP_EXTENSION_PCT: soglia minima di distanza dal
// VWAP per entrare (default 1,2%) — asse diverso dallo stop già testato.
const EXP_ORB_RANGE_MINUTES = process.env.EXP_ORB_RANGE_MINUTES ? Number(process.env.EXP_ORB_RANGE_MINUTES) : null;
const EXP_ORB_VOLUME_MULT = process.env.EXP_ORB_VOLUME_MULT ? Number(process.env.EXP_ORB_VOLUME_MULT) : null;
const EXP_VWAP_MAX_HOLD_MIN = process.env.EXP_VWAP_MAX_HOLD_MIN ? Number(process.env.EXP_VWAP_MAX_HOLD_MIN) : null;
const EXP_VWAP_EXTENSION_PCT = process.env.EXP_VWAP_EXTENSION_PCT ? Number(process.env.EXP_VWAP_EXTENSION_PCT) : null;
if (EXP_ORB_RANGE_MINUTES != null) console.log(`ORB: range di apertura override=${EXP_ORB_RANGE_MINUTES} min (produzione: 15)`);
if (EXP_ORB_VOLUME_MULT != null) console.log(`ORB: soglia volume override=${EXP_ORB_VOLUME_MULT}× (produzione: 1.8×)`);
if (EXP_VWAP_MAX_HOLD_MIN != null) console.log(`VWAP: max hold override=${EXP_VWAP_MAX_HOLD_MIN} min (produzione: 45)`);
if (EXP_VWAP_EXTENSION_PCT != null) console.log(`VWAP: soglia estensione override=${EXP_VWAP_EXTENSION_PCT}% (produzione: 1.2%)`);
const dailyNet: Record<"orb" | "vwap" | "pairs", number[]> = { orb: [], vwap: [], pairs: [] };

interface AlpacaIntradayBarRaw {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vw: number;
}
interface AlpacaCalendarEntry {
  date: string;
}

/** beforeDateIso, se dato, ancora la finestra PRIMA di quella data (esclusa) invece che su oggi — per test fuori campione. */
async function fetchTradingDays(count: number, beforeDateIso?: string): Promise<string[]> {
  const end = beforeDateIso ?? new Date().toISOString().slice(0, 10);
  const start = new Date(new Date(end).getTime() - (count + 15) * 86_400_000).toISOString().slice(0, 10);
  const cal = await alpacaFetch<AlpacaCalendarEntry[]>(`/v2/calendar?start=${start}&end=${end}`);
  const days = cal.map((c) => c.date);
  const filtered = beforeDateIso ? days.filter((d) => d < beforeDateIso) : days;
  return filtered.slice(-count);
}

/**
 * Con molti simboli la risposta multi-simbolo di Alpaca non entra sempre in una sola
 * pagina: senza seguire next_page_token, alcuni simboli risultano silenziosamente senza
 * barre. Stesso bug trovato e corretto in api/cron/tick.ts allargando l'universo a 40 titoli.
 */
async function fetchPaginated<T>(basePath: string): Promise<Record<string, T[]>> {
  const merged: Record<string, T[]> = {};
  let pageToken: string | null = null;
  for (;;) {
    const path: string = basePath + (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : "");
    const raw: { bars?: Record<string, T[]>; next_page_token?: string | null } = await alpacaDataFetch(path);
    for (const [symbol, bars] of Object.entries(raw.bars ?? {})) {
      (merged[symbol] ??= []).push(...bars);
    }
    pageToken = raw.next_page_token ?? null;
    if (!pageToken) break;
  }
  return merged;
}

async function fetchSessionBars(startUtc: string, endUtc: string): Promise<Record<string, AlpacaIntradayBarRaw[]>> {
  const merged = await fetchPaginated<AlpacaIntradayBarRaw>(
    `/v2/stocks/bars?symbols=${encodeURIComponent(UNIVERSE_SYMBOLS.join(","))}&timeframe=5Min&limit=3000&feed=iex&sort=asc&start=${encodeURIComponent(startUtc)}&end=${encodeURIComponent(endUtc)}`
  );
  const out: Record<string, AlpacaIntradayBarRaw[]> = {};
  for (const s of UNIVERSE_SYMBOLS) out[s] = merged[s] ?? [];
  return out;
}

function sessionVWAP(bars: AlpacaIntradayBarRaw[]): number | null {
  const totalVol = bars.reduce((s, b) => s + b.v, 0);
  if (totalVol === 0) return null;
  return bars.reduce((s, b) => s + b.vw * b.v, 0) / totalVol;
}

async function loadDailyClosesBeforeDate(beforeDateIso: string): Promise<Record<string, OrbDailyBar[]>> {
  const out: Record<string, OrbDailyBar[]> = {};
  for (const symbol of UNIVERSE_SYMBOLS) {
    const rows = (await sql.query(
      `SELECT trading_date, open, high, low, close FROM daily_bars
       WHERE symbol = $1 AND trading_date < $2 ORDER BY trading_date DESC LIMIT 120`,
      [symbol, beforeDateIso]
    )) as { trading_date: string; open: string; high: string; low: string; close: string }[];
    out[symbol] = rows
      .reverse()
      .map((r) => ({ t: r.trading_date, o: Number(r.open), h: Number(r.high), l: Number(r.low), c: Number(r.close) }));
  }
  return out;
}

interface SimOrbPos extends OrbOpenPosition {}

function decideOrbExitsIntrabar(
  open: SimOrbPos[],
  barNow: Record<string, AlpacaIntradayBarRaw | undefined>
): ReturnType<typeof decideOrbExits> {
  const out: ReturnType<typeof decideOrbExits> = [];
  for (const pos of open) {
    const bar = barNow[pos.symbol];
    if (!bar) continue;
    const long = pos.side === 'LONG';
    const stopHit = long ? bar.l <= pos.stopPrice : bar.h >= pos.stopPrice;
    const targetHit = long ? bar.h >= pos.targetPrice : bar.l <= pos.targetPrice;
    if (!stopHit && !targetHit) continue;
    const isStop = stopHit; // stessa barra: prevale lo stop
    const level = isStop ? pos.stopPrice : pos.targetPrice;
    let exitPrice = level;
    if (isStop) exitPrice = long ? Math.min(level, bar.o) : Math.max(level, bar.o);
    const dir = long ? 1 : -1;
    out.push({
      position: pos,
      exitPrice,
      realizedPnl: Math.round(pos.qty * (exitPrice - pos.entryPrice) * dir),
      reason: isStop ? 'stop' : 'target',
    });
  }
  return out;
}
interface SimVwapPos extends VwapOpenPosition {}
interface SimPairLeg extends OpenLeg {}

const anomalies: string[] = [];
function flag(msg: string) {
  anomalies.push(msg);
  console.warn("  ANOMALIA:", msg);
}

const totals = {
  orb: { realized: 0, entries: 0, exits: 0, exitReasons: {} as Record<string, number> },
  vwap: { realized: 0, entries: 0, exits: 0, exitReasons: {} as Record<string, number> },
  pairs: { realized: 0, entries: 0, exits: 0, exitReasons: {} as Record<string, number> },
};

async function run() {
  const dayCount = Number(process.argv[2]) || 5;
  const beforeDateIso = process.argv[3] || undefined;
  const tradingDays = await fetchTradingDays(dayCount, beforeDateIso);
  console.log(`Rigioco ${tradingDays.length} giorni di mercato: ${tradingDays.join(", ")}\n`);

  let nextId = 1;
  let orbOpen: SimOrbPos[] = [];
  let vwapOpen: SimVwapPos[] = [];
  let pairsOpen: SimPairLeg[] = [];
  const strategyOf = new Map<number, "orb" | "vwap" | "pairs">();

  for (const day of tradingDays) {
    const realizedBefore = { orb: totals.orb.realized, vwap: totals.vwap.realized, pairs: totals.pairs.realized };
    const session = await fetchMarketSession(day);
    if (!session) {
      flag(`[${day}] nessuna sessione nel calendario Alpaca (inatteso per un trading day)`);
      continue;
    }

    const sessionBars = await fetchSessionBars(session.openUtc, session.closeUtc);
    const openMs = new Date(session.openUtc).getTime();
    for (const s of UNIVERSE_SYMBOLS) {
      for (const b of sessionBars[s]) {
        if (new Date(b.t).getTime() < openMs) {
          flag(`[${day}] ${s}: barra pre-market rilevata (${b.t} < apertura ${session.openUtc}) — regressione bug di contaminazione già corretto in passato`);
        }
      }
    }

    const timeSet = new Set<string>();
    for (const s of UNIVERSE_SYMBOLS) for (const b of sessionBars[s]) timeSet.add(b.t);
    const times = [...timeSet].sort();
    if (times.length === 0) {
      flag(`[${day}] nessuna barra intraday ricevuta per nessun simbolo, salto il giorno`);
      continue;
    }

    const dailyBarsBefore = await loadDailyClosesBeforeDate(day);
    const closesBySymbol: Record<string, number[]> = {};
    for (const s of UNIVERSE_SYMBOLS) closesBySymbol[s] = dailyBarsBefore[s].map((b) => b.c);

    const orbAtr: Record<string, number> = {};
    for (const s of UNIVERSE_SYMBOLS) {
      const atr = computeATRPct(dailyBarsBefore[s]);
      if (atr != null) orbAtr[s] = atr;
    }

    const vwapTrend: Record<string, VwapTrendContext> = {};
    for (const s of UNIVERSE_SYMBOLS) {
      const sma = computeSMA(closesBySymbol[s], VWAP_TREND_FILTER_DAYS);
      const efficiency = computeTrendEfficiency(closesBySymbol[s], VWAP_TREND_FILTER_DAYS);
      if (sma != null && efficiency != null) vwapTrend[s] = { sma, efficiency };
    }
    if (Object.keys(orbAtr).length === 0) flag(`[${day}] ATR non calcolabile per nessun simbolo (storico daily insufficiente prima di questa data)`);

    let pairStats: PairStats[] = selectPairs(closesBySymbol);
    const openPairKeysAtStart = new Set(pairsOpen.map((l) => l.pairKey));
    for (const key of openPairKeysAtStart) {
      if (pairStats.some((p) => pairKey(p.a, p.b) === key)) continue;
      const [a, b] = key.split("/");
      const st = statsForPair(a, b, closesBySymbol);
      if (st) pairStats.push(st);
    }

    let openingRanges: Record<string, OpeningRange> = {};
    const vwapStoppedToday = new Set<string>();
    const vwapEntriesToday: Record<string, number> = {};
    const orbEntriesToday: Record<string, number> = {};
    const orbBreakoutStreak: Record<string, { side: "LONG" | "SHORT"; count: number }> = {};
    let dayCounters = { orbEntries: 0, orbExits: 0, vwapEntries: 0, vwapExits: 0, pairsEntries: 0, pairsExits: 0, vwapPnl: 0 };
    const closeMs = new Date(session.closeUtc).getTime();
    const stoppedPairsToday = new Set<string>(); // raffreddamento post-stop, azzerato a ogni giorno

    for (const timeIso of times) {
      const now = new Date(timeIso);
      const barsUpToNow: Record<string, AlpacaIntradayBarRaw[]> = {};
      const prices: Record<string, number> = {};
      for (const s of UNIVERSE_SYMBOLS) {
        const bars = sessionBars[s].filter((b) => new Date(b.t).getTime() <= now.getTime());
        barsUpToNow[s] = bars;
        if (bars.length > 0) prices[s] = bars[bars.length - 1].c;
      }

      if (Object.keys(openingRanges).length === 0) {
        for (const s of UNIVERSE_SYMBOLS) {
          const range = computeOpeningRange(barsUpToNow[s].map((b) => ({ h: b.h, l: b.l })), EXP_ORB_RANGE_MINUTES ?? undefined);
          if (range) openingRanges[s] = range;
        }
      }

      const vwapSnapshots: Record<string, VwapSnapshot> = {};
      for (const s of UNIVERSE_SYMBOLS) {
        const vwap = sessionVWAP(barsUpToNow[s]);
        if (prices[s] != null && vwap != null) vwapSnapshots[s] = { price: prices[s], vwap };
      }
      const vwapBars: Record<string, VwapBar[]> = {};
      for (const s of UNIVERSE_SYMBOLS) vwapBars[s] = barsUpToNow[s].map((b) => ({ t: b.t, c: b.c }));

      let vwapExits: ReturnType<typeof decideVwapExits> = [];
      let orbExits: ReturnType<typeof decideOrbExits> = [];
      let pairsExits: ReturnType<typeof decidePairsExits> = [];
      try {
        vwapExits = decideVwapExits(vwapOpen, vwapSnapshots, now, EXP_VWAP_STOP_PCT ?? undefined, EXP_VWAP_MAX_HOLD_MIN ?? undefined);
      } catch (e) {
        flag(`[${day} ${timeIso}] eccezione in decideVwapExits: ${(e as Error).message}`);
      }
      try {
        if (ORB_INTRABAR) {
          const barNow: Record<string, AlpacaIntradayBarRaw | undefined> = {};
          for (const sym of UNIVERSE_SYMBOLS) {
            const bs = barsUpToNow[sym];
            const last = bs[bs.length - 1];
            if (last && last.t === timeIso) barNow[sym] = last;
          }
          orbExits = decideOrbExitsIntrabar(orbOpen, barNow);
        } else {
          orbExits = decideOrbExits(orbOpen, prices);
        }
      } catch (e) {
        flag(`[${day} ${timeIso}] eccezione in decideOrbExits: ${(e as Error).message}`);
      }
      const pairStatsByKey: Record<string, PairStats> = {};
      for (const p of pairStats) pairStatsByKey[pairKey(p.a, p.b)] = p;
      try {
        pairsExits = decidePairsExits(pairsOpen, prices, pairStatsByKey);
      } catch (e) {
        flag(`[${day} ${timeIso}] eccezione in decidePairsExits: ${(e as Error).message}`);
      }

      for (const ex of vwapExits) {
        totals.vwap.realized += ex.realizedPnl;
        totals.vwap.exits++;
        dayCounters.vwapExits++;
        dayCounters.vwapPnl += ex.realizedPnl;
        totals.vwap.exitReasons[ex.reason] = (totals.vwap.exitReasons[ex.reason] ?? 0) + 1;
        if (ex.reason === "stop_loss") vwapStoppedToday.add(ex.position.symbol);
        vwapOpen = vwapOpen.filter((p) => p.id !== ex.position.id);
        strategyOf.delete(ex.position.id);
      }
      for (const ex of orbExits) {
        totals.orb.realized += ex.realizedPnl;
        totals.orb.exits++;
        dayCounters.orbExits++;
        totals.orb.exitReasons[ex.reason] = (totals.orb.exitReasons[ex.reason] ?? 0) + 1;
        orbOpen = orbOpen.filter((p) => p.id !== ex.position.id);
        strategyOf.delete(ex.position.id);
      }
      for (const ex of pairsExits) {
        totals.pairs.realized += ex.realizedPnl;
        totals.pairs.exits++;
        dayCounters.pairsExits++;
        totals.pairs.exitReasons[ex.reason] = (totals.pairs.exitReasons[ex.reason] ?? 0) + 1;
        pairsOpen = pairsOpen.filter((l) => !ex.legIds.includes(l.id));
        for (const id of ex.legIds) strategyOf.delete(id);
        if (ex.reason === "stop") stoppedPairsToday.add(ex.pairKey);
      }

      const minutesToClose = (closeMs - now.getTime()) / 60_000;
      const nearClose = minutesToClose <= 20;

      if (!nearClose) {
        const vwapStillOpenSymbols = new Set(vwapOpen.map((p) => p.symbol));
        let vwapEntries: ReturnType<typeof decideVwapEntries> = [];
        // I simboli bloccati dalle varianti si passano come "già aperti" (decideEntries li salta);
        // gli slot liberi restano calcolati sulle sole posizioni davvero aperte.
        const vwapBlocked = new Set(vwapStillOpenSymbols);
        for (const s of UNIVERSE_SYMBOLS) {
          if (EXP_VWAP_COOLDOWN_STOP && vwapStoppedToday.has(s)) vwapBlocked.add(s);
          if (EXP_VWAP_MAX_ENTRIES > 0 && (vwapEntriesToday[s] ?? 0) >= EXP_VWAP_MAX_ENTRIES) vwapBlocked.add(s);
        }
        const vwapTrendUsed = EXP_VWAP_TREND === false ? {} : vwapTrend;
        try {
          vwapEntries = decideVwapEntries(UNIVERSE_SYMBOLS, vwapBlocked, vwapSnapshots, vwapBars, VWAP_MAX_POSITIONS - vwapStillOpenSymbols.size, vwapTrendUsed, EXP_VWAP_EXTENSION_PCT ?? undefined);
        } catch (e) {
          flag(`[${day} ${timeIso}] eccezione in decideVwapEntries: ${(e as Error).message}`);
        }
        for (const e of vwapEntries) {
          const id = nextId++;
          vwapOpen.push({ id, symbol: e.symbol, side: e.side, qty: e.qty, entryPrice: e.entryPrice, entryTime: timeIso });
          strategyOf.set(id, "vwap");
          vwapEntriesToday[e.symbol] = (vwapEntriesToday[e.symbol] ?? 0) + 1;
          totals.vwap.entries++;
          dayCounters.vwapEntries++;
        }

        const orbStillOpenSymbols = new Set(orbOpen.map((p) => p.symbol));
        const orbInputs: Record<string, OrbEntryInputs> = {};
        for (const s of UNIVERSE_SYMBOLS) {
          const range = openingRanges[s];
          const atr = orbAtr[s];
          const bars = barsUpToNow[s];
          const price = prices[s];
          if (!range || atr == null || bars.length === 0 || price == null) continue;

          // Striscia di barre consecutive oltre il range, nella stessa direzione — per
          // EXP_ORB_CONFIRM_BARS. Aggiornata per ogni simbolo con dati validi, aperto o no.
          const brokeUp = price > range.high;
          const brokeDown = price < range.low;
          if (brokeUp || brokeDown) {
            const side: "LONG" | "SHORT" = brokeUp ? "LONG" : "SHORT";
            const prev = orbBreakoutStreak[s];
            orbBreakoutStreak[s] = prev && prev.side === side ? { side, count: prev.count + 1 } : { side, count: 1 };
          } else {
            delete orbBreakoutStreak[s];
          }

          if (EXP_ORB_MAX_ENTRIES > 0 && (orbEntriesToday[s] ?? 0) >= EXP_ORB_MAX_ENTRIES) continue;
          const rangePct = ((range.high - range.low) / price) * 100;
          if (EXP_ORB_MIN_RANGE_PCT > 0 && rangePct < EXP_ORB_MIN_RANGE_PCT) continue;
          if (EXP_ORB_CONFIRM_BARS > 1 && (orbBreakoutStreak[s]?.count ?? 0) < EXP_ORB_CONFIRM_BARS) continue;

          const avgVol = bars.reduce((a, b) => a + b.v, 0) / bars.length;
          orbInputs[s] = { price, openingRange: range, atrPct: atr, avgBarVolume: avgVol, latestBarVolume: bars[bars.length - 1].v };
        }
        let orbEntries: ReturnType<typeof decideOrbEntries> = [];
        try {
          orbEntries = decideOrbEntries(UNIVERSE_SYMBOLS, orbStillOpenSymbols, orbInputs, ORB_MAX_POSITIONS - orbStillOpenSymbols.size, EXP_ORB_VOLUME_MULT ?? undefined);
        } catch (e) {
          flag(`[${day} ${timeIso}] eccezione in decideOrbEntries: ${(e as Error).message}`);
        }
        for (const e of orbEntries) {
          const id = nextId++;
          let stopPrice = e.stopPrice;
          const range = openingRanges[e.symbol];
          if (EXP_ORB_STOP_MULT != null && range) {
            const width = range.high - range.low;
            stopPrice = e.side === "LONG" ? e.entryPrice - EXP_ORB_STOP_MULT * width : e.entryPrice + EXP_ORB_STOP_MULT * width;
          }
          orbOpen.push({ id, symbol: e.symbol, side: e.side, qty: e.qty, entryPrice: e.entryPrice, stopPrice, targetPrice: e.targetPrice });
          strategyOf.set(id, "orb");
          orbEntriesToday[e.symbol] = (orbEntriesToday[e.symbol] ?? 0) + 1;
          totals.orb.entries++;
          dayCounters.orbEntries++;
        }

        const pairsStillOpenKeys = new Set(pairsOpen.map((l) => l.pairKey));
        const pairsExcludedKeys = new Set([...pairsStillOpenKeys, ...stoppedPairsToday]);
        let pairsEntries: ReturnType<typeof decidePairsEntries> = [];
        try {
          const minutesFromOpen = (now.getTime() - openMs) / 60_000;
          if (minutesFromOpen >= EXP_PAIRS_DELAY_MIN) {
            pairsEntries = decidePairsEntries(pairStats, pairsExcludedKeys, prices, MAX_PAIRS - pairsStillOpenKeys.size);
          }
        } catch (e) {
          flag(`[${day} ${timeIso}] eccezione in decidePairsEntries: ${(e as Error).message}`);
        }
        for (const e of pairsEntries) {
          for (const leg of e.legs) {
            const id = nextId++;
            pairsOpen.push({ id, pairKey: e.pairKey, symbol: leg.symbol, side: leg.side, qty: leg.qty, entryPrice: leg.entryPrice });
            strategyOf.set(id, "pairs");
          }
          totals.pairs.entries += e.legs.length;
          dayCounters.pairsEntries += e.legs.length;
        }
      }

      // Controlli di sanità a ogni passo
      if (orbOpen.length > ORB_MAX_POSITIONS) flag(`[${day} ${timeIso}] ORB supera MAX_POSITIONS: ${orbOpen.length} > ${ORB_MAX_POSITIONS}`);
      if (vwapOpen.length > VWAP_MAX_POSITIONS) flag(`[${day} ${timeIso}] VWAP supera MAX_POSITIONS: ${vwapOpen.length} > ${VWAP_MAX_POSITIONS}`);
      const legsByPair = new Map<string, number>();
      for (const l of pairsOpen) legsByPair.set(l.pairKey, (legsByPair.get(l.pairKey) ?? 0) + 1);
      if (legsByPair.size > MAX_PAIRS) flag(`[${day} ${timeIso}] pairs supera MAX_PAIRS: ${legsByPair.size} > ${MAX_PAIRS}`);
      for (const [key, count] of legsByPair) if (count !== 2) flag(`[${day} ${timeIso}] coppia ${key} ha ${count} gambe aperte, attese 2`);
      for (const p of [...orbOpen, ...vwapOpen, ...pairsOpen]) {
        if (!Number.isFinite(p.qty) || p.qty <= 0) flag(`[${day} ${timeIso}] qty non valida per ${p.symbol}: ${p.qty}`);
        if (!Number.isFinite(p.entryPrice) || p.entryPrice <= 0) flag(`[${day} ${timeIso}] entryPrice non valido per ${p.symbol}: ${p.entryPrice}`);
      }
    }

    // Rete di sicurezza EOD, come in tick.ts dopo il fix: singole (ORB/VWAP) riga per riga,
    // coppie come unità unica (entrambe le gambe solo se il P&L combinato è positivo).
    const lastPrices: Record<string, number> = {};
    for (const s of UNIVERSE_SYMBOLS) {
      const bars = sessionBars[s];
      if (bars.length > 0) lastPrices[s] = bars[bars.length - 1].c;
    }

    const singleRows: LabOpenRow[] = [
      ...orbOpen.map((p) => ({ id: p.id, symbol: p.symbol, side: p.side, qty: p.qty, entryPrice: p.entryPrice })),
      ...vwapOpen.map((p) => ({ id: p.id, symbol: p.symbol, side: p.side, qty: p.qty, entryPrice: p.entryPrice })),
    ];
    let singleCloses: ReturnType<typeof decideLabEodCloses> = [];
    try {
      singleCloses = decideLabEodCloses(singleRows, lastPrices);
    } catch (e) {
      flag(`[${day}] eccezione in decideLabEodCloses: ${(e as Error).message}`);
    }
    for (const c of singleCloses) {
      const strat = strategyOf.get(c.id);
      if (strat) {
        totals[strat].realized += c.realizedPnl;
        totals[strat].exits++;
        totals[strat].exitReasons["eod_safety_net"] = (totals[strat].exitReasons["eod_safety_net"] ?? 0) + 1;
        if (strat === "vwap") dayCounters.vwapPnl += c.realizedPnl;
      } else {
        flag(`[${day}] chiusura EOD per id ${c.id} senza strategia nota (bug di bookkeeping nel backtest, non nel prodotto)`);
      }
      strategyOf.delete(c.id);
    }

    let pairEodCloses: ReturnType<typeof decidePairsEodCloses> = [];
    try {
      pairEodCloses = decidePairsEodCloses(pairsOpen, lastPrices);
    } catch (e) {
      flag(`[${day}] eccezione in decidePairsEodCloses: ${(e as Error).message}`);
    }
    const pairEodLegIds = new Set<number>();
    for (const pc of pairEodCloses) {
      for (const legId of pc.legIds) {
        pairEodLegIds.add(legId);
        const leg = pairsOpen.find((l) => l.id === legId);
        const price = leg ? lastPrices[leg.symbol] : undefined;
        if (!leg || price == null) continue;
        const dir = leg.side === "LONG" ? 1 : -1;
        totals.pairs.realized += Math.round(leg.qty * (price - leg.entryPrice) * dir);
        totals.pairs.exits++;
        totals.pairs.exitReasons["eod_safety_net"] = (totals.pairs.exitReasons["eod_safety_net"] ?? 0) + 1;
        strategyOf.delete(legId);
      }
    }

    const eodIds = new Set(singleCloses.map((c) => c.id));
    orbOpen = orbOpen.filter((p) => !eodIds.has(p.id));
    vwapOpen = vwapOpen.filter((p) => !eodIds.has(p.id));
    pairsOpen = pairsOpen.filter((l) => !pairEodLegIds.has(l.id));
    const eodCloses = [...singleCloses, ...[...pairEodLegIds].map((id) => ({ id }))];

    dailyNet.orb.push(totals.orb.realized - realizedBefore.orb);
    dailyNet.vwap.push(totals.vwap.realized - realizedBefore.vwap);
    dailyNet.pairs.push(totals.pairs.realized - realizedBefore.pairs);

    console.log(
      `[${day}] orb: ${dayCounters.orbEntries} entrate/${dayCounters.orbExits} uscite | ` +
        `vwap: ${dayCounters.vwapEntries} entrate/${dayCounters.vwapExits} uscite (pnl=${dayCounters.vwapPnl}) | ` +
        `pairs: ${dayCounters.pairsEntries} entrate/${dayCounters.pairsExits} uscite | ` +
        `EOD: ${eodCloses.length} chiuse | posizioni residue: orb=${orbOpen.length} vwap=${vwapOpen.length} pairs=${pairsOpen.length}`
    );
  }

  console.log("\n=== Riepilogo finale ===");
  for (const [name, t] of Object.entries(totals)) {
    console.log(`${name}: ${t.entries} entrate, ${t.exits} uscite, P&L realizzato = ${t.realized}, motivi uscita:`, t.exitReasons);
  }
  // Regole di scelta giornaliera della strategia (analogo del debriefing): P&L che si sarebbe
  // ottenuto scegliendo ogni giorno una strategia con la regola indicata, calcolato sui risultati
  // giornalieri del backtest (lab). Solo indicativo: le sedute sono poche.
  const ids = ["orb", "vwap", "pairs"] as const;
  const n = dailyNet.orb.length;
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const rule = (label: string, pick: (d: number) => (typeof ids)[number] | null) => {
    let total = 0;
    let scelte = 0;
    for (let d = 1; d < n; d++) {
      const p = pick(d);
      if (!p) continue;
      total += dailyNet[p][d];
      scelte++;
    }
    console.log(`  ${label}: ${total} (su ${scelte} sedute)`);
  };
  const bestBy = (window: number) => (d: number) => {
    const from = Math.max(0, d - window);
    return ids.reduce((best, id) => (sum(dailyNet[id].slice(from, d)) > sum(dailyNet[best].slice(from, d)) ? id : best), ids[0]);
  };
  console.log("\n=== Regole di scelta giornaliera (P&L lab, seduta 2..N) ===");
  for (const id of ids) rule(`sempre ${id}`, () => id);
  rule("vincitore di ieri (1 seduta)", bestBy(1));
  rule("vincitore ultime 5 sedute", bestBy(5));
  rule("vincitore ultime 20 sedute", bestBy(20));
  let mediaTot = 0;
  for (let d = 1; d < n; d++) mediaTot += (dailyNet.orb[d] + dailyNet.vwap[d] + dailyNet.pairs[d]) / 3;
  console.log(`  diversificata (1/3 ciascuna): ${Math.round(mediaTot)}`);
  let oracolo = 0;
  for (let d = 1; d < n; d++) oracolo += Math.max(dailyNet.orb[d], dailyNet.vwap[d], dailyNet.pairs[d]);
  console.log(`  oracolo (migliore del giorno, irrealizzabile): ${oracolo}`);

  console.log(`\nAnomalie rilevate: ${anomalies.length}`);
  for (const a of anomalies) console.log(" -", a);
  if (anomalies.length === 0) console.log("Nessuna anomalia rilevata sui giorni testati.");
}

run().catch((err) => {
  console.error("Backtest fallito:", err);
  process.exit(1);
});

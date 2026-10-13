// Analisi dei trade chiusi (reale e lab): logica PURA, nessun I/O. L'esecutore con le letture dal
// database e l'invio della mail è server/dailyReview.ts.
//
// Cosa fa, e perché (13/10/2026): ogni perdita "di esecuzione" scoperta finora (size doppia, doppia
// chiusura di BA, gamba orfana, collisione tra strategie) è stata ricostruita a mano giorni dopo.
// Qui, a fine seduta, ogni trade viene descritto con dati derivati da quello che il sistema già
// salva (session_bars, pairs_zscore_log, lab_positions, real_positions): escursione massima
// contraria e favorevole, segnale a ingresso/uscita, durata, e — per i trade reali — il confronto
// col gemello nel lab con la causa dello scarto.
//
// Cosa NON fa: non propone né applica modifiche alla strategia. Misura e segnala. Il giudizio sui
// parametri resta al protocollo di validazione su più finestre (CLAUDE.md), non a una singola seduta.
//
// Limiti dichiarati:
//   - MAE/MFE sono approssimati con barre da 5 minuti (l'estremo reale dentro una barra non è noto)
//     e, per le coppie, con le chiusure delle barre allineate sulle due gambe;
//   - il "gemello" lab è abbinato per strategia/titolo/lato e ingresso nello stesso tick (±6 min):
//     la size è diversa (reale pesato per convinzione), quindi si confrontano rendimenti sul
//     nozionale, non dollari;
//   - la causa dello scarto è un'euristica a soglie (GAP_TOLERANCE_PCT), non una prova.

import { LAB_COST_PCT_PER_SIDE } from "./costs.js";

export type Side = "LONG" | "SHORT";
export type Source = "real" | "lab";

/** Riga chiusa di real_positions o lab_positions, normalizzata. Gli orari sono ISO UTC. */
export interface ClosedRow {
  id: number;
  source: Source;
  strategyId: string;
  symbol: string;
  side: Side;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  entryTime: string;
  exitTime: string;
  realizedPnl: number;
  exitReason: string | null;
  pairKey: string | null;
  conviction: number | null;
}

/** Un trade: una posizione singola, oppure le due gambe di una coppia aperte nello stesso tick. */
export interface TradeUnit {
  source: Source;
  strategyId: string;
  /** Simbolo, oppure chiave di coppia. */
  subject: string;
  side: Side | "PAIR";
  legs: ClosedRow[];
  entryTime: string;
  exitTime: string;
  holdMinutes: number;
  /** Nozionale d'ingresso: somma qty × prezzo su tutte le gambe. */
  notional: number;
  grossPnl: number;
  /** Costo stimato di esecuzione: solo per il lab (il reale paga lo slippage vero nei fill). */
  costEst: number;
  netPnl: number;
  exitReason: string | null;
  conviction: number | null;
}

export interface Bar {
  /** Inizio barra, ms epoch. */
  t: number;
  h: number;
  l: number;
  c: number;
  vwap: number;
}

const FIVE_MIN_MS = 5 * 60_000;
/** Tolleranza per dire che due ingressi (reale e lab) sono nello stesso tick. */
export const TWIN_TOLERANCE_MS = 6 * 60_000;
/** Sotto questo scarto di rendimento (punti %) reale e lab sono "in linea": ~4× lo slippage per lato misurato (0,023%). */
export const GAP_TOLERANCE_PCT = 0.1;

const dirOf = (side: Side): 1 | -1 => (side === "LONG" ? 1 : -1);

// ---------------------------------------------------------------------------------------------
// Raggruppamento in trade
// ---------------------------------------------------------------------------------------------

export function groupUnits(rows: ClosedRow[]): TradeUnit[] {
  const groups = new Map<string, ClosedRow[]>();
  for (const r of rows) {
    const key = r.pairKey ? `${r.source}|${r.strategyId}|${r.pairKey}|${r.entryTime}` : `${r.source}|${r.strategyId}|#${r.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  const units: TradeUnit[] = [];
  for (const legs of groups.values()) {
    const first = legs[0];
    const entryMs = Math.min(...legs.map((l) => Date.parse(l.entryTime)));
    const exitMs = Math.max(...legs.map((l) => Date.parse(l.exitTime)));
    const notional = legs.reduce((s, l) => s + l.qty * l.entryPrice, 0);
    const grossPnl = legs.reduce((s, l) => s + l.realizedPnl, 0);
    const costEst =
      first.source === "lab" ? legs.reduce((s, l) => s + LAB_COST_PCT_PER_SIDE * l.qty * (l.entryPrice + l.exitPrice), 0) : 0;
    const isPair = first.pairKey != null;
    // Motivo d'uscita del trade: una pulizia manuale o una gamba orfana contano più del motivo ordinario
    // dell'altra gamba; altrimenti vale quello della gamba chiusa per ultima.
    const reasons = legs.map((l) => l.exitReason).filter((x): x is string => x != null);
    const lastLeg = legs.reduce((a, b) => (Date.parse(b.exitTime) >= Date.parse(a.exitTime) ? b : a));
    const exitReason = reasons.find((x) => x.startsWith("manual")) ?? (reasons.includes("orphan_leg") ? "orphan_leg" : (lastLeg.exitReason ?? null));
    units.push({
      source: first.source,
      strategyId: first.strategyId,
      subject: isPair ? first.pairKey! : first.symbol,
      side: isPair ? "PAIR" : first.side,
      legs,
      entryTime: new Date(entryMs).toISOString(),
      exitTime: new Date(exitMs).toISOString(),
      holdMinutes: Math.round((exitMs - entryMs) / 60_000),
      notional,
      grossPnl,
      costEst,
      netPnl: grossPnl - costEst,
      exitReason,
      conviction: legs.reduce<number | null>((m, l) => (l.conviction == null ? m : Math.max(m ?? 0, l.conviction)), null),
    });
  }
  return units.sort((a, b) => a.entryTime.localeCompare(b.entryTime) || a.subject.localeCompare(b.subject));
}

// ---------------------------------------------------------------------------------------------
// Escursione massima contraria / favorevole (MAE / MFE)
// ---------------------------------------------------------------------------------------------

/**
 * P&L non realizzato peggiore e migliore (in $) lungo la vita del trade, da barre da 5 minuti.
 * Posizione singola: massimi/minimi delle barre. Coppia: valore di mercato combinato sulle chiusure
 * delle barre presenti per entrambe le gambe. Include anche il punto finale (P&L realizzato).
 * Restituisce null se non ci sono barre nell'intervallo (es. dati mancanti): meglio un vuoto che un
 * numero inventato.
 */
export function computeExcursion(unit: TradeUnit, barsBySymbol: Record<string, Bar[]>): { mae: number | null; mfe: number | null } {
  const entryMs = Date.parse(unit.entryTime);
  const exitMs = Date.parse(unit.exitTime);
  const inWindow = (b: Bar) => b.t > entryMs - FIVE_MIN_MS && b.t <= exitMs;

  let mae = 0;
  let mfe = 0;
  let seen = false;

  if (unit.legs.length === 1) {
    const leg = unit.legs[0];
    const dir = dirOf(leg.side);
    for (const b of barsBySymbol[leg.symbol] ?? []) {
      if (!inWindow(b)) continue;
      seen = true;
      const worst = dir === 1 ? b.l : b.h;
      const best = dir === 1 ? b.h : b.l;
      mae = Math.min(mae, leg.qty * (worst - leg.entryPrice) * dir);
      mfe = Math.max(mfe, leg.qty * (best - leg.entryPrice) * dir);
    }
  } else {
    // Coppia: serie del valore combinato sulle sole barre comuni.
    const perSymbol = unit.legs.map((leg) => {
      const m = new Map<number, number>();
      for (const b of barsBySymbol[leg.symbol] ?? []) if (inWindow(b)) m.set(b.t, b.c);
      return m;
    });
    const times = [...perSymbol[0].keys()].filter((t) => perSymbol.every((m) => m.has(t))).sort((a, b) => a - b);
    for (const t of times) {
      seen = true;
      let v = 0;
      unit.legs.forEach((leg, i) => {
        v += leg.qty * (perSymbol[i].get(t)! - leg.entryPrice) * dirOf(leg.side);
      });
      mae = Math.min(mae, v);
      mfe = Math.max(mfe, v);
    }
  }

  if (!seen) return { mae: null, mfe: null };
  // Il punto di uscita (realizzato) fa parte del percorso.
  mae = Math.min(mae, unit.grossPnl);
  mfe = Math.max(mfe, unit.grossPnl);
  return { mae, mfe };
}

// ---------------------------------------------------------------------------------------------
// Segnale a ingresso/uscita (ricostruito, non salvato al momento della decisione)
// ---------------------------------------------------------------------------------------------

/** Z-score più vicino nel tempo a `targetMs` entro `toleranceMs`, da pairs_zscore_log (scritto a ogni tick). */
export function nearestZ(log: { t: number; z: number }[], targetMs: number, toleranceMs = 3 * 60_000): number | null {
  let best: { d: number; z: number } | null = null;
  for (const p of log) {
    const d = Math.abs(p.t - targetMs);
    if (d <= toleranceMs && (!best || d < best.d)) best = { d, z: p.z };
  }
  return best ? best.z : null;
}

/** Distanza % (con segno) dal VWAP di giornata nella barra che contiene l'ingresso. */
export function vwapDistancePct(entryPrice: number, bars: Bar[], entryMs: number): number | null {
  let bar: Bar | null = null;
  for (const b of bars) {
    if (b.t <= entryMs && (!bar || b.t > bar.t)) bar = b;
  }
  if (!bar || bar.vwap <= 0) return null;
  return ((entryPrice - bar.vwap) / bar.vwap) * 100;
}

/** Forza della rottura ORB in frazioni dell'ampiezza del range (stessa definizione di realExecution.ts). */
export function orbBreakout(entryPrice: number, side: Side, range: { high: number; low: number }): number | null {
  const width = range.high - range.low;
  if (width <= 0) return null;
  return side === "LONG" ? (entryPrice - range.high) / width : (range.low - entryPrice) / width;
}

// ---------------------------------------------------------------------------------------------
// Gemello reale ↔ lab e causa dello scarto
// ---------------------------------------------------------------------------------------------

function signature(u: TradeUnit): string {
  const legs = u.legs
    .map((l) => `${l.symbol}:${l.side}`)
    .sort()
    .join(",");
  return `${u.strategyId}|${legs}`;
}

/** Abbina ogni trade reale al trade lab con stessa strategia/titoli/lato e ingresso più vicino (±TWIN_TOLERANCE_MS). Ritorna indice reale → indice lab. */
export function matchTwins(real: TradeUnit[], lab: TradeUnit[]): Map<number, number> {
  const used = new Set<number>();
  const out = new Map<number, number>();
  real.forEach((r, ri) => {
    const rSig = signature(r);
    const rMs = Date.parse(r.entryTime);
    let best: { li: number; d: number } | null = null;
    lab.forEach((l, li) => {
      if (used.has(li) || signature(l) !== rSig) return;
      const d = Math.abs(Date.parse(l.entryTime) - rMs);
      if (d <= TWIN_TOLERANCE_MS && (!best || d < best.d)) best = { li, d };
    });
    if (best) {
      used.add((best as { li: number }).li);
      out.set(ri, (best as { li: number }).li);
    }
  });
  return out;
}

export type GapCause =
  /** Reale e lab hanno reso lo stesso (entro GAP_TOLERANCE_PCT): l'esito è del mercato/della strategia. */
  | "in_line"
  /** Stessa uscita (stesso tick e motivo) ma prezzi di fill diversi oltre tolleranza: esecuzione. */
  | "slippage"
  /** Il reale è uscito in un altro momento o per un altro motivo del lab: non è slippage. */
  | "exit_timing"
  /** Il lab teneva la stessa posizione (stessa strategia/titoli/lato) ma è entrato in un altro tick: i prezzi non sono confrontabili, non è un'anomalia. */
  | "entry_timing"
  /** Nessuna posizione lab corrispondente nemmeno sovrapposta nel tempo: il reale ha fatto qualcosa che la strategia nel lab non ha deciso. */
  | "no_twin";

export interface GapAnalysis {
  cause: GapCause;
  /** P&L lordo del gemello lab (dollari sul suo nozionale, non scalati). */
  twinGross: number | null;
  /** Rendimento reale − rendimento lab, in punti % del nozionale (negativo = il reale ha reso meno). */
  returnGapPct: number | null;
  /** Costo medio dello slippage d'ingresso, % del prezzo, pesato per nozionale (positivo = sfavorevole). */
  entrySlipPct: number | null;
  exitSlipPct: number | null;
}

export function analyzeGap(real: TradeUnit, lab: TradeUnit | null, labOverlaps = false): GapAnalysis {
  if (!lab) {
    return { cause: labOverlaps ? "entry_timing" : "no_twin", twinGross: null, returnGapPct: null, entrySlipPct: null, exitSlipPct: null };
  }

  const realRet = real.notional > 0 ? (real.grossPnl / real.notional) * 100 : 0;
  const labRet = lab.notional > 0 ? (lab.grossPnl / lab.notional) * 100 : 0;
  const returnGapPct = realRet - labRet;

  let entryW = 0;
  let exitW = 0;
  let wSum = 0;
  for (const rl of real.legs) {
    const ll = lab.legs.find((x) => x.symbol === rl.symbol && x.side === rl.side);
    if (!ll || ll.entryPrice <= 0 || ll.exitPrice <= 0) continue;
    const dir = dirOf(rl.side);
    const w = rl.qty * rl.entryPrice;
    // Sfavorevole = positivo: LONG che compra più caro / vende più basso, SHORT che vende più basso / compra più alto.
    entryW += w * dir * ((rl.entryPrice - ll.entryPrice) / ll.entryPrice) * 100;
    exitW += w * -dir * ((rl.exitPrice - ll.exitPrice) / ll.exitPrice) * 100;
    wSum += w;
  }
  const entrySlipPct = wSum > 0 ? entryW / wSum : null;
  const exitSlipPct = wSum > 0 ? exitW / wSum : null;

  const sameTick = Math.abs(Date.parse(real.exitTime) - Date.parse(lab.exitTime)) <= TWIN_TOLERANCE_MS;
  const sameReason = (real.exitReason ?? "") === (lab.exitReason ?? "");
  let cause: GapCause;
  if (!sameTick || !sameReason) cause = "exit_timing";
  else if (Math.abs(returnGapPct) < GAP_TOLERANCE_PCT) cause = "in_line";
  else cause = "slippage";

  return { cause, twinGross: lab.grossPnl, returnGapPct, entrySlipPct, exitSlipPct };
}

// ---------------------------------------------------------------------------------------------
// Rapporto serale
// ---------------------------------------------------------------------------------------------

export interface ReviewedTrade extends TradeUnit {
  mae: number | null;
  mfe: number | null;
  entrySignal: number | null;
  exitSignal: number | null;
  twin: GapAnalysis | null;
}

export interface OpenPairView {
  pairKey: string;
  legs: string;
  sessionsHeld: number;
  unrealized: number | null;
  mae: number | null;
  entryZ: number | null;
  currentZ: number | null;
}

export interface SkippedView {
  strategyId: string;
  subject: string;
  reason: string;
  detail: string | null;
  signal: number | null;
  ticks: number;
}

export interface TickHealth {
  totalTicks: number;
  openTicks: number;
  maxGapMin: number;
  firstUtc: string | null;
  lastUtc: string | null;
  errorNotes: string[];
}

export interface CumulativeView {
  source: Source;
  strategyId: string;
  n: number;
  net: number;
  wins: number;
  avgMae: number | null;
}

export interface ReportInput {
  date: string;
  equity: { equity: number; lastEquity: number } | null;
  real: ReviewedTrade[];
  lab: ReviewedTrade[];
  openPairs: OpenPairView[];
  skipped: SkippedView[];
  health: TickHealth | null;
  consistencyLines: string[];
  anomalies: string[];
  cumulative: CumulativeView[];
}

const money = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(0)}$`;
const pct = (n: number, d = 2) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(d)}%`;
const STRATEGY_LABEL: Record<string, string> = { orb: "ORB", vwap_reversion: "VWAP", pairs: "Pairs" };
const label = (id: string) => STRATEGY_LABEL[id] ?? id;

const REASON_LABEL: Record<string, string> = {
  occupied_symbol: "titolo occupato da un'altra strategia",
  not_shortable: "non shortabile / hard-to-borrow",
  cooldown_stop: "raffreddamento dopo stop",
  no_free_slots: "slot esauriti",
  sizing_zero: "sizing a zero",
  daily_loss_halt: "limite di perdita giornaliero",
};

/** Soglia sotto la quale il campione di trade non permette di giudicare un vantaggio (vedi CLAUDE.md). */
export const MIN_TRADES_FOR_JUDGEMENT = 40;

/** Punti che richiedono attenzione, in ordine di importanza. Pura. */
export function buildFlags(input: ReportInput): string[] {
  const flags: string[] = [];

  if (input.health) {
    if (input.health.maxGapMin > 10) flags.push(`Buco nei tick: ${input.health.maxGapMin.toFixed(0)} minuti senza esecuzione a mercato aperto.`);
    if (input.health.errorNotes.length > 0) flags.push(`Errori nelle note dei tick (${input.health.errorNotes.length}): ${input.health.errorNotes[0].slice(0, 140)}`);
    if (input.health.openTicks < 60) flags.push(`Solo ${input.health.openTicks} tick a mercato aperto (attesi ~78).`);
  }
  for (const a of input.anomalies) flags.push(`Coerenza: ${a}`);

  for (const t of input.real) {
    const g = t.twin;
    if (!g) continue;
    if (g.cause === "no_twin") flags.push(`Trade reale senza gemello nel lab: ${label(t.strategyId)} ${t.subject} (${money(t.grossPnl)}, uscita ${t.exitReason ?? "n/d"}).`);
    else if (g.cause === "slippage") {
      flags.push(
        `Scarto di esecuzione su ${label(t.strategyId)} ${t.subject}: reale ${pct(g.returnGapPct ?? 0)} rispetto al lab (slippage ingresso ${pct(g.entrySlipPct ?? 0, 3)}, uscita ${pct(g.exitSlipPct ?? 0, 3)}).`
      );
    }
  }

  for (const s of input.skipped) {
    if (s.reason === "daily_loss_halt") flags.push(`Limite di perdita giornaliero raggiunto: nuovi ingressi bloccati su ${label(s.strategyId)}.`);
  }
  const blocked = input.skipped.filter((s) => s.reason === "occupied_symbol");
  if (blocked.length > 0) {
    flags.push(
      `${blocked.length} segnal${blocked.length === 1 ? "e" : "i"} bloccat${blocked.length === 1 ? "o" : "i"} da un titolo occupato: ${blocked
        .slice(0, 3)
        .map((b) => `${label(b.strategyId)} ${b.subject}`)
        .join(", ")}${blocked.length > 3 ? "…" : ""}. Il lab li ha presi, il reale no.`
    );
  }

  for (const p of input.openPairs) {
    if (p.sessionsHeld >= 10) flags.push(`Coppia ${p.pairKey} aperta da ${p.sessionsHeld} sedute (z attuale ${p.currentZ != null ? p.currentZ.toFixed(2) : "n/d"}).`);
    if (p.currentZ != null && Math.abs(p.currentZ) >= 4.5) flags.push(`Coppia ${p.pairKey}: |z| ${Math.abs(p.currentZ).toFixed(2)}, vicino allo stop a 6,0.`);
    if (input.equity && p.unrealized != null && p.unrealized <= -0.005 * input.equity.equity) {
      flags.push(`Coppia ${p.pairKey}: non realizzato ${money(p.unrealized)} (oltre −0,5% dell'equity).`);
    }
  }

  if (input.equity && input.equity.lastEquity > 0) {
    const d = (input.equity.equity - input.equity.lastEquity) / input.equity.lastEquity;
    if (d <= -0.0075) flags.push(`Equity ${pct(d * 100)} su ieri: vicina al limite giornaliero di −1%.`);
  }
  return flags;
}

export function buildDailyReport(input: ReportInput): string[] {
  const L: string[] = [];
  const flags = buildFlags(input);

  L.push(`WHAD Trading — recap seduta ${input.date}`);
  L.push("");
  L.push(flags.length === 0 ? "ESITO: nessun punto di attenzione." : `ESITO: ${flags.length} punt${flags.length === 1 ? "o" : "i"} di attenzione.`);
  for (const f of flags) L.push(`  ! ${f}`);
  L.push("");

  // Risultato del giorno
  const realGross = input.real.reduce((s, t) => s + t.grossPnl, 0);
  L.push("RISULTATO DEL GIORNO");
  if (input.equity) {
    L.push(`  Equity ${input.equity.equity.toFixed(0)}$ (${money(input.equity.equity - input.equity.lastEquity)} su ieri, realizzato + non realizzato)`);
  }
  L.push(`  Reale, realizzato oggi: ${money(realGross)} su ${input.real.length} trade chiusi`);
  for (const id of ["pairs", "orb", "vwap_reversion"]) {
    const t = input.lab.filter((x) => x.strategyId === id);
    if (t.length === 0) continue;
    const net = t.reduce((s, x) => s + x.netPnl, 0);
    L.push(`  Lab ${label(id)}: ${money(net)} netto di costi, ${t.length} trade`);
  }
  L.push("");

  // Trade reali, uno per uno
  if (input.real.length > 0) {
    L.push("TRADE REALI CHIUSI OGGI");
    for (const t of input.real) {
      const parts = [
        `${label(t.strategyId)} ${t.subject}`,
        `${money(t.grossPnl)}`,
        `${t.holdMinutes >= 1440 ? `${(t.holdMinutes / 1440).toFixed(1)}g` : `${t.holdMinutes}min`}`,
        `uscita ${t.exitReason ?? "n/d"}`,
      ];
      if (t.mae != null && t.mfe != null) parts.push(`escursione ${money(t.mae)} / ${money(t.mfe)}`);
      if (t.entrySignal != null) parts.push(`segnale ingresso ${t.entrySignal.toFixed(2)}`);
      if (t.twin) {
        const g = t.twin;
        parts.push(
          g.cause === "no_twin"
            ? "gemello lab: nessuno"
            : g.cause === "entry_timing"
              ? "lab entrato in un altro momento (non confrontabile)"
              : `vs lab: ${g.cause === "in_line" ? "in linea" : g.cause === "slippage" ? "scarto di esecuzione" : "uscita in momento/motivo diverso"} (${pct(g.returnGapPct ?? 0)})`
        );
      }
      L.push(`  • ${parts.join(" · ")}`);
    }
    L.push("");
  }

  // Coppie aperte
  if (input.openPairs.length > 0) {
    L.push("COPPIE REALI ANCORA APERTE");
    for (const p of input.openPairs) {
      L.push(
        `  • ${p.pairKey} (${p.legs}) · ${p.sessionsHeld} sedut${p.sessionsHeld === 1 ? "a" : "e"} · non realizzato ${p.unrealized != null ? money(p.unrealized) : "n/d"}` +
          ` · peggiore ${p.mae != null ? money(p.mae) : "n/d"} · z ingresso ${p.entryZ != null ? p.entryZ.toFixed(2) : "n/d"} → ora ${p.currentZ != null ? p.currentZ.toFixed(2) : "n/d"}`
      );
    }
    L.push("");
  }

  // Segnali non eseguiti
  if (input.skipped.length > 0) {
    L.push("SEGNALI VISTI E NON ESEGUITI DAL REALE");
    for (const s of input.skipped) {
      L.push(
        `  • ${label(s.strategyId)} ${s.subject}: ${REASON_LABEL[s.reason] ?? s.reason}${s.detail ? ` (${s.detail})` : ""}` +
          `${s.signal != null ? ` · segnale ${s.signal.toFixed(2)}` : ""} · ${s.ticks} tick`
      );
    }
    L.push("");
  }

  // Salute del sistema
  L.push("SALUTE DEL SISTEMA");
  if (input.health) {
    const h = input.health;
    L.push(`  Tick a mercato aperto: ${h.openTicks} (${h.firstUtc ?? "n/d"}–${h.lastUtc ?? "n/d"} UTC), buco massimo ${h.maxGapMin.toFixed(1)} min`);
  }
  for (const l of input.consistencyLines) L.push(`  ${l}`);
  L.push("");

  // Base dati cumulata, con il promemoria sulla numerosità
  if (input.cumulative.length > 0) {
    L.push("BASE DATI CUMULATA (trade rivisti dal 13/10/2026, più lo storico ricostruito)");
    for (const c of input.cumulative) {
      L.push(
        `  ${c.source === "real" ? "Reale" : "Lab  "} ${label(c.strategyId).padEnd(6)} ${String(c.n).padStart(4)} trade · netto ${money(c.net).padStart(7)} · vinti ${c.n > 0 ? Math.round((c.wins / c.n) * 100) : 0}%` +
          `${c.avgMae != null ? ` · escursione contraria media ${money(c.avgMae)}` : ""}`
      );
    }
    const pairsReal = input.cumulative.find((c) => c.source === "real" && c.strategyId === "pairs");
    if (!pairsReal || pairsReal.n < MIN_TRADES_FOR_JUDGEMENT) {
      L.push(`  Nota: sotto ${MIN_TRADES_FOR_JUDGEMENT} trade reali di pairs (ora ${pairsReal?.n ?? 0}) l'edge non è giudicabile: nessuna modifica di parametri da una singola seduta.`);
    }
  }
  return L;
}

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LiveMarketData, PnlMode, RealLabOverrides } from "../data/mockData";
import { FALLBACK_LIVE_MARKET_DATA, SESSION_RULES, buildLiveMarketData, mergeRealLabData } from "../data/mockData";
import { fetchLiveQuotes } from "../lib/marketQuotes";
import { fetchLabPositions } from "../lib/labPositions";
import { confirmDebrief, fetchDebrief, type RealDebrief } from "../lib/debrief";
import { useMarketClock } from "../hooks/useMarketClock";
import type { DataStatus } from "../types";

const PNL_MODE_KEY = "whad.pnlMode";
const QUOTES_POLL_MS = 20_000;
const LAB_POSITIONS_POLL_MS = 20_000;

export type MarketDataSource = "loading" | "live" | "mock" | "offline";

interface AppStateValue {
  pnlMode: PnlMode;
  setPnlMode: (mode: PnlMode) => void;
  confirmed: boolean;
  confirmedAt: string | null;
  confirmChoice: () => void;
  now: Date;
  eodAutoClose: boolean;
  autoConfirm: boolean;
  liveMarket: LiveMarketData;
  marketSource: MarketDataSource;
  /** Strategie con posizioni reali (lab_positions) attualmente disponibili — vuoto finché nessun tick ha girato. */
  realLabStrategies: RealLabOverrides;
  /** Stato del fetch di /api/lab/positions (non delle singole strategie: quello è realLabStrategies). */
  labPositionsSource: DataStatus;
  /** Classifica/proposta/storico reali del debriefing (GET /api/debrief) — null finché non disponibili, le view ricadono sui dati finti. */
  realDebrief: RealDebrief | null;
  /** Stato del fetch di /api/debrief: "mock" = endpoint raggiunto ma nessuno storico ancora. */
  debriefSource: DataStatus;
  /** Orario di mercato reale (per il badge MERCATO CHIUSO e il banner di conferma mancante). */
  marketClock: { isOpen: boolean | null; source: DataStatus };
}

const AppStateContext = createContext<AppStateValue | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [pnlMode, setPnlModeState] = useState<PnlMode>(() => {
    if (typeof window === "undefined") return "abs";
    const stored = window.localStorage.getItem(PNL_MODE_KEY);
    return stored === "pct" ? "pct" : "abs";
  });
  const [confirmed, setConfirmed] = useState(false);
  const [confirmedAt, setConfirmedAt] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [quoteMarket, setQuoteMarket] = useState<LiveMarketData>(FALLBACK_LIVE_MARKET_DATA);
  const [marketSource, setMarketSource] = useState<MarketDataSource>("loading");
  const [realLabData, setRealLabData] = useState<RealLabOverrides>({});
  const [labPositionsSource, setLabPositionsSource] = useState<DataStatus>("loading");
  const [realDebrief, setRealDebrief] = useState<RealDebrief | null>(null);
  const [debriefSource, setDebriefSource] = useState<DataStatus>("loading");
  const marketClock = useMarketClock();
  const cancelledRef = useRef(false);
  const labCancelledRef = useRef(false);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    cancelledRef.current = false;

    const poll = async () => {
      try {
        const quotes = await fetchLiveQuotes();
        if (cancelledRef.current) return;
        if (Object.keys(quotes).length === 0) {
          // Nessuna quotazione utilizzabile (es. mercato mai aperto oggi): resta sul fallback, non è un errore.
          setMarketSource((s) => (s === "live" ? s : "mock"));
          return;
        }
        setQuoteMarket(buildLiveMarketData(quotes));
        setMarketSource("live");
      } catch {
        // Fetch fallito per davvero (non solo "nessuna quotazione"): segnala offline invece di
        // restare silenziosamente su un "live" ormai stantio o confonderlo con un mock legittimo.
        if (cancelledRef.current) return;
        setMarketSource("offline");
      }
    };

    poll();
    const id = setInterval(poll, QUOTES_POLL_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    labCancelledRef.current = false;

    const poll = async () => {
      try {
        const real = await fetchLabPositions();
        if (labCancelledRef.current) return;
        setRealLabData(real);
        setLabPositionsSource("live");
      } catch {
        // Endpoint non raggiungibile (dev senza vercel dev, o problema reale): offline, non "nessun dato ancora".
        if (labCancelledRef.current) return;
        setLabPositionsSource("offline");
      }
    };

    poll();
    const id = setInterval(poll, LAB_POSITIONS_POLL_MS);
    return () => {
      labCancelledRef.current = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchDebrief()
      .then((real) => {
        if (cancelled) return;
        setRealDebrief(real);
        setDebriefSource(real.sessionsUsed > 0 ? "live" : "mock");
      })
      .catch(() => {
        // Endpoint non raggiungibile per davvero: offline. Le view ricadono sui dati finti.
        if (cancelled) return;
        setDebriefSource("offline");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const liveMarket = useMemo(() => mergeRealLabData(quoteMarket, realLabData), [quoteMarket, realLabData]);

  const setPnlMode = (mode: PnlMode) => {
    setPnlModeState(mode);
    try {
      window.localStorage.setItem(PNL_MODE_KEY, mode);
    } catch {
      // localStorage non disponibile: la preferenza resta solo per la sessione corrente
    }
  };

  /**
   * Se il debriefing reale è disponibile, la conferma viene scritta sul server (persiste,
   * sopravvive al refresh — usata stasera da eod-close.ts per lo storico). Se non lo è
   * (endpoint non raggiungibile, dev senza DB) ricade sullo stato locale di sempre, che si
   * perde al refresh ma tiene comunque utilizzabile la UI.
   */
  const confirmChoice = async () => {
    if (realDebrief) {
      try {
        const { confirmedAt: serverConfirmedAt } = await confirmDebrief();
        setRealDebrief((prev) => (prev ? { ...prev, confirmedAt: serverConfirmedAt } : prev));
        return;
      } catch {
        // Scrittura fallita: ricadi sul fallback locale sotto, invece di lasciare il bottone senza effetto.
      }
    }
    setConfirmed(true);
    setConfirmedAt(
      new Date().toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })
    );
  };

  const value = useMemo<AppStateValue>(
    () => ({
      pnlMode,
      setPnlMode,
      confirmed: realDebrief ? realDebrief.confirmedAt != null : confirmed,
      confirmedAt: realDebrief ? realDebrief.confirmedAt : confirmedAt,
      confirmChoice,
      now,
      eodAutoClose: SESSION_RULES.closeProfitableAtEod,
      autoConfirm: SESSION_RULES.autoConfirm,
      liveMarket,
      marketSource,
      realLabStrategies: realLabData,
      labPositionsSource,
      realDebrief,
      debriefSource,
      marketClock,
    }),
    [
      pnlMode,
      confirmed,
      confirmedAt,
      now,
      liveMarket,
      marketSource,
      realLabData,
      labPositionsSource,
      realDebrief,
      debriefSource,
      marketClock,
    ]
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error("useAppState deve essere usato dentro AppStateProvider");
  return ctx;
}

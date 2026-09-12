import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LiveMarketData, PnlMode, RealLabOverrides } from "../data/mockData";
import { FALLBACK_LIVE_MARKET_DATA, SESSION_RULES, buildLiveMarketData, mergeRealLabData } from "../data/mockData";
import { fetchLiveQuotes } from "../lib/marketQuotes";
import { fetchLabPositions } from "../lib/labPositions";

const PNL_MODE_KEY = "whad.pnlMode";
const QUOTES_POLL_MS = 20_000;
const LAB_POSITIONS_POLL_MS = 20_000;

export type MarketDataSource = "loading" | "live" | "mock";

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
          // Nessuna quotazione utilizzabile (es. mercato mai aperto oggi): resta sul fallback.
          setMarketSource((s) => (s === "loading" ? "mock" : s));
          return;
        }
        setQuoteMarket(buildLiveMarketData(quotes));
        setMarketSource("live");
      } catch {
        if (cancelledRef.current) return;
        setMarketSource((s) => (s === "live" ? s : "mock"));
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
      } catch {
        // Endpoint non disponibile (dev senza vercel dev, o nessun tick ha ancora girato): resta sulla simulazione.
      }
    };

    poll();
    const id = setInterval(poll, LAB_POSITIONS_POLL_MS);
    return () => {
      labCancelledRef.current = true;
      clearInterval(id);
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

  const confirmChoice = () => {
    setConfirmed(true);
    setConfirmedAt(
      new Date().toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })
    );
  };

  const value = useMemo<AppStateValue>(
    () => ({
      pnlMode,
      setPnlMode,
      confirmed,
      confirmedAt,
      confirmChoice,
      now,
      eodAutoClose: SESSION_RULES.closeProfitableAtEod,
      autoConfirm: SESSION_RULES.autoConfirm,
      liveMarket,
      marketSource,
      realLabStrategies: realLabData,
    }),
    [pnlMode, confirmed, confirmedAt, now, liveMarket, marketSource, realLabData]
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error("useAppState deve essere usato dentro AppStateProvider");
  return ctx;
}

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { PnlMode } from "../data/mockData";
import { SESSION_RULES } from "../data/mockData";

const PNL_MODE_KEY = "whad.pnlMode";

interface AppStateValue {
  pnlMode: PnlMode;
  setPnlMode: (mode: PnlMode) => void;
  confirmed: boolean;
  confirmedAt: string | null;
  confirmChoice: () => void;
  now: Date;
  eodAutoClose: boolean;
  autoConfirm: boolean;
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

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

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
    }),
    [pnlMode, confirmed, confirmedAt, now]
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error("useAppState deve essere usato dentro AppStateProvider");
  return ctx;
}

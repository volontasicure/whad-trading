import { useEffect, useState } from "react";
import { alpacaAdapter } from "../lib/brokerAdapters/alpaca";
import { EXECUTIONS, REAL_PORTFOLIO, periodPnlFor } from "../data/mockData";
import type { Execution, PeriodPnl, Position } from "../types";

export interface RealPortfolioData {
  positions: Position[];
  realizedToday: number;
  unrealized: number;
  periodPnl: PeriodPnl;
  executions: Execution[];
}

export type RealPortfolioSource = "loading" | "live" | "offline";

const POLL_MS = 30_000;

const MOCK_DATA: RealPortfolioData = {
  positions: REAL_PORTFOLIO.positions,
  realizedToday: REAL_PORTFOLIO.realizedToday,
  unrealized: REAL_PORTFOLIO.unrealized,
  periodPnl: periodPnlFor("real"),
  executions: EXECUTIONS,
};

/**
 * Dati reali del conto Alpaca (posizioni, P&L per periodo, esecuzioni).
 * A differenza dei lab, qui non esiste un "nessun dato ancora" legittimo: se il fetch
 * riesce, anche zero posizioni sono un dato reale (source "live"); "offline" indica solo
 * che l'adapter non è raggiungibile — a quel punto si vedono i dati finti come segnaposto.
 * Nota: finché non vengono piazzati ordini reali sul conto paper, posizioni ed esecuzioni
 * risulteranno comunque vuote anche a source "live" — è il comportamento atteso, non un bug.
 */
export function useRealPortfolio(): { data: RealPortfolioData; source: RealPortfolioSource } {
  const [data, setData] = useState<RealPortfolioData>(MOCK_DATA);
  const [source, setSource] = useState<RealPortfolioSource>("loading");

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const sinceMidnight = new Date();
        sinceMidnight.setHours(0, 0, 0, 0);
        const [positions, day, week, month, inception, executions] = await Promise.all([
          alpacaAdapter.getPositions("real"),
          alpacaAdapter.getRealizedPnl("real", "day"),
          alpacaAdapter.getRealizedPnl("real", "week"),
          alpacaAdapter.getRealizedPnl("real", "month"),
          alpacaAdapter.getRealizedPnl("real", "inception"),
          alpacaAdapter.getExecutions("real", sinceMidnight.toISOString()),
        ]);
        if (cancelled) return;
        const unrealized = positions.reduce((acc, p) => acc + p.unrealized, 0);
        setData({
          positions,
          realizedToday: day,
          unrealized,
          periodPnl: {
            portfolioId: "real",
            lastSession: day,
            previousWeek: week,
            previousMonth: month,
            sinceInception: inception,
            inceptionDate: MOCK_DATA.periodPnl.inceptionDate,
          },
          executions,
        });
        setSource("live");
      } catch {
        if (cancelled) return;
        setData(MOCK_DATA);
        setSource("offline");
      }
    };

    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return { data, source };
}

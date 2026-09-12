import { useEffect, useState } from "react";
import { alpacaAdapter } from "../lib/brokerAdapters/alpaca";
import { BROKERS } from "../data/mockData";
import type { BrokerStatus } from "../types";

const MOCK_ALPACA = BROKERS.find((b) => b.id === "alpaca")!;

export type AlpacaStatusSource = "loading" | "live" | "unavailable";

/**
 * Stato del broker Alpaca: prova a leggerlo dal backend reale (/api/broker/status);
 * se non risponde (chiavi non configurate, o `npm run dev` senza le funzioni serverless)
 * ripiega silenziosamente sui dati finti, senza far fallire la UI.
 */
export function useAlpacaStatus(): { source: AlpacaStatusSource; data: BrokerStatus } {
  const [source, setSource] = useState<AlpacaStatusSource>("loading");
  const [data, setData] = useState<BrokerStatus>(MOCK_ALPACA);

  useEffect(() => {
    let cancelled = false;
    alpacaAdapter
      .status()
      .then((s) => {
        if (cancelled) return;
        setData(s);
        setSource("live");
      })
      .catch(() => {
        if (cancelled) return;
        setData(MOCK_ALPACA);
        setSource("unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { source, data };
}

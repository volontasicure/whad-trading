import { useEffect, useState } from "react";
import { alpacaAdapter } from "../lib/brokerAdapters/alpaca";
import type { DataStatus } from "../types";

const POLL_MS = 60_000;

/**
 * Orario di mercato reale (aperto/chiuso), da /api/broker/clock. isOpen resta null finché
 * non arriva la prima risposta: chi lo consuma deve trattare null come "non sappiamo ancora",
 * mai come "chiuso" — evita falsi negativi (es. banner di conferma) prima del primo fetch.
 */
export function useMarketClock(): { isOpen: boolean | null; source: DataStatus } {
  const [isOpen, setIsOpen] = useState<boolean | null>(null);
  const [source, setSource] = useState<DataStatus>("loading");

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const clock = await alpacaAdapter.marketClock();
        if (cancelled) return;
        setIsOpen(clock.isOpen);
        setSource("live");
      } catch {
        if (cancelled) return;
        setSource("offline");
      }
    };

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return { isOpen, source };
}

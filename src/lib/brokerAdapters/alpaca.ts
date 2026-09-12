import type { BrokerAdapter, Quote } from "../../types";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/broker${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    throw new Error(`Broker API ${path} -> ${res.status}`);
  }
  return (await res.json()) as T;
}

/**
 * Implementazione Alpaca di BrokerAdapter. Rappresenta solo il conto reale:
 * i tre portafogli laboratorio restano una simulazione interna (vedi CLAUDE.md),
 * quindi `portfolioId` è ignorato qui — non esiste un conto Alpaca per lab.
 */
export const alpacaAdapter: BrokerAdapter = {
  id: "alpaca",
  displayName: "Alpaca",

  status: () => api("/status"),

  getPositions: () => api("/positions"),

  getRealizedPnl: (_portfolioId, period) => api<{ value: number }>(`/pnl?period=${period}`).then((r) => r.value),

  getExecutions: (_portfolioId, since) => api(`/executions?since=${encodeURIComponent(since)}`),

  submitOrder: (o) => api("/orders", { method: "POST", body: JSON.stringify(o) }),

  closePosition: (symbol) => api(`/positions/${encodeURIComponent(symbol)}`, { method: "DELETE" }),

  marketClock: () => api("/clock"),

  streamQuotes: (_symbols: string[], _cb: (q: Quote) => void) => {
    throw new Error(
      "streamQuotes non ancora implementato: lo streaming Alpaca richiede una connessione persistente " +
        "che non può vivere in una funzione serverless Vercel. Serve un servizio a lunga esecuzione separato " +
        "(vedi 'Prossimi passi' in CLAUDE.md)."
    );
  },
};

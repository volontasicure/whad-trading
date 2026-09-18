import type { VercelRequest, VercelResponse } from "@vercel/node";
import { alpacaFetch } from "../../server/alpaca.js";
import { db } from "../../server/db.js";

interface AlpacaFillActivity {
  activity_type: "FILL";
  symbol: string;
  side: "buy" | "sell";
  qty: string;
  price: string;
  transaction_time: string;
  order_id: string;
  /** "filled" solo sul fill che completa l'ordine (leaves_qty 0) — un ordine può avere più
   *  righe FILL per riempimenti parziali, tutte con status intermedi prima di quella finale. */
  order_status: string;
}

interface ClosedRealPosition {
  broker_exit_order_id: string;
  realized_pnl: number;
}

/**
 * Esecuzioni reali (fill Alpaca) con il realized attaccato quando disponibile: il fill che
 * completa un ordine di chiusura (order_status "filled") viene incrociato con
 * real_positions.broker_exit_order_id, che ha già il realized vero calcolato sul round-trip
 * (server/realExecution.ts) — nessun lot-matching sui dati del broker, stessa fonte già usata
 * da api/broker/pnl.ts. I fill di apertura, o parziali prima del completamento, restano null:
 * non hanno ancora un realized definito.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const since = typeof req.query.since === "string" ? req.query.since : undefined;
  const qs = new URLSearchParams({ direction: "asc", ...(since ? { after: since } : {}) });
  try {
    const [raw, exitRows] = await Promise.all([
      alpacaFetch<AlpacaFillActivity[]>(`/v2/account/activities/FILL?${qs.toString()}`),
      db()`
        SELECT broker_exit_order_id, realized_pnl::float8 AS realized_pnl
        FROM real_positions
        WHERE status = 'closed' AND broker_exit_order_id IS NOT NULL AND exit_time >= ${since ?? "1970-01-01"}
      ` as unknown as Promise<ClosedRealPosition[]>,
    ]);
    const realizedByExitOrder = new Map(exitRows.map((r) => [r.broker_exit_order_id, r.realized_pnl]));

    const executions = raw.map((f) => ({
      ts: f.transaction_time,
      symbol: f.symbol,
      action: f.side === "buy" ? ("BUY" as const) : ("SELL" as const),
      qty: Number(f.qty),
      price: Number(f.price),
      realized: f.order_status === "filled" ? (realizedByExitOrder.get(f.order_id) ?? null) : null,
    }));
    res.status(200).json(executions);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}

import { useEffect, useState } from "react";
import { StatusBadge } from "../components/StatusBadge";
import { dec, money, pnlColor } from "../data/mockData";
import { fetchTrend, type TrendSnapshotView } from "../lib/trend";
import type { DataStatus } from "../types";

const NAMES: Record<string, string> = {
  SPY: "S&P 500",
  QQQ: "Nasdaq 100",
  IWM: "Small cap USA",
  EFA: "Sviluppati ex-USA",
  EEM: "Mercati emergenti",
  VNQ: "Immobiliare USA",
  TLT: "Treasury 20+ anni",
  IEF: "Treasury 7-10 anni",
  LQD: "Corporate investment grade",
  GLD: "Oro",
  DBC: "Materie prime",
  UUP: "Dollaro USA",
};

const COLS = "minmax(150px, 1.5fr) minmax(130px, 1.2fr) minmax(70px, 0.8fr) minmax(70px, 0.8fr) minmax(60px, 0.7fr) minmax(80px, 0.9fr) minmax(80px, 0.9fr) minmax(80px, 0.9fr)";

function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("it-IT", { month: "long", year: "numeric" });
}

export function TrendView() {
  const [data, setData] = useState<TrendSnapshotView | null>(null);
  const [status, setStatus] = useState<DataStatus>("loading");

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const d = await fetchTrend();
        if (!alive) return;
        setData(d);
        setStatus("live");
      } catch {
        if (alive) setStatus("offline");
      }
    };
    void load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const rows = data?.rows ?? [];
  const sorted = [...rows].sort((a, b) => b.weightPct - a.weightPct || b.targetWeightPct - a.targetWeightPct || a.symbol.localeCompare(b.symbol));
  const aboveCount = rows.filter((r) => r.signal?.above).length;

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 20,
          flexWrap: "wrap",
          padding: "26px 30px 18px",
          background: "var(--bg-subtle)",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0 }}>
          <div className="view-kicker">LAB D · SOLO SIMULAZIONE, NESSUN ORDINE REALE</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div className="view-title">Trend following su ETF</div>
            {status === "live" ? (
              // Non "REALE": qui i dati sono veri ma il portafoglio è simulato, per non confonderli con il conto reale.
              <div className="mono" title="Posizioni dal database del lab, prezzi dal mercato" style={{ fontSize: 8.5, letterSpacing: "0.08em", padding: "2px 5px", borderRadius: 4, whiteSpace: "nowrap", background: "var(--fill-neutral)", color: "var(--text-faint)" }}>
                DATI LAB
              </div>
            ) : (
              <StatusBadge status={status} title={status === "offline" ? "Stato del lab D non raggiungibile" : "Caricamento"} />
            )}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "stretch", gap: 22, flexWrap: "wrap" }}>
          <HeaderStat label="CAPITALE LAB" value="100.000 $" />
          <HeaderStat label="UNIVERSO" value="12 ETF liquidi" />
          <HeaderStat label="RIBILANCIAMENTO" value="mensile" />
        </div>
      </div>

      <div style={{ padding: "22px 30px 40px", display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
          <Kpi label="EQUITY" value={data ? `${Math.round(data.equity).toLocaleString("it-IT")} $` : "—"} color="var(--text-primary)" sub={data?.startedAt ? `dal ${new Date(data.startedAt).toLocaleDateString("it-IT")}` : "in attesa del primo ribilanciamento"} />
          <Kpi label="P&L DA INIZIO" value={data ? money(data.pnl) : "—"} color={data ? pnlColor(data.pnl) : "var(--text-faint)"} sub={data ? `${data.pnlPct >= 0 ? "+" : "−"}${dec(Math.abs(data.pnlPct), 2)}% · realizzato ${money(data.realizedNet)} · aperto ${money(data.unrealized)}` : ""} />
          <Kpi label="ESPOSIZIONE" value={data ? `${dec(100 - data.cashPct, 0)}%` : "—"} color="var(--text-primary)" sub={data ? `liquidità ${dec(data.cashPct, 0)}% · ${aboveCount} ETF sopra la media` : ""} />
          <Kpi
            label="PROSSIMO RIBILANCIAMENTO"
            value={data ? (data.lastRebalance ? monthLabel(data.nextRebalanceMonth) : "al primo avvio") : "—"}
            color="var(--text-primary)"
            sub={data?.lastRebalance ? `ultimo il ${new Date(data.lastRebalance.date).toLocaleDateString("it-IT")}: ${data.lastRebalance.closes} chiuse, ${data.lastRebalance.opens} aperte` : "alla prima esecuzione a mercato aperto"}
          />
        </div>

        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ padding: "15px 18px", borderBottom: "1px solid var(--border-divider)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div style={{ fontSize: 15, fontWeight: 500 }}>Segnali e posizioni</div>
            <div className="mono" style={{ fontSize: 10, letterSpacing: "0.1em", color: "var(--text-faint)" }}>
              SEGNALE CALCOLATO AL RIBILANCIAMENTO · PREZZI IN TEMPO QUASI REALE
            </div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <div style={{ minWidth: 860 }}>
              <div style={{ display: "grid", gridTemplateColumns: COLS, alignItems: "center", padding: "0 18px", height: 34, background: "var(--bg-subtle)", borderBottom: "1px solid var(--border-divider)" }}>
                <div className="table-header-cell">ETF</div>
                <div className="table-header-cell">SEGNALE (MEDIA 200 SEDUTE)</div>
                <div className="table-header-cell" style={{ textAlign: "right" }}>PESO OBIETT.</div>
                <div className="table-header-cell" style={{ textAlign: "right" }}>PESO ORA</div>
                <div className="table-header-cell" style={{ textAlign: "right" }}>AZIONI</div>
                <div className="table-header-cell" style={{ textAlign: "right" }}>MEDIO</div>
                <div className="table-header-cell" style={{ textAlign: "right" }}>ULTIMO</div>
                <div className="table-header-cell" style={{ textAlign: "right" }}>UNREAL.</div>
              </div>
              {sorted.length === 0 && (
                <div style={{ padding: "22px 18px", fontSize: 12.5, color: "var(--text-faint)" }}>
                  {status === "offline" ? "Stato non raggiungibile." : status === "loading" ? "Caricamento…" : "Nessun dato ancora: il primo ribilanciamento avviene alla prima esecuzione a mercato aperto."}
                </div>
              )}
              {sorted.map((r) => (
                <div key={r.symbol} className="row-hover" style={{ display: "grid", gridTemplateColumns: COLS, alignItems: "center", padding: "0 18px", height: 46, borderBottom: "1px solid var(--border-subtle)" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                    <div className="mono" style={{ fontSize: 12.5, fontWeight: 500 }}>{r.symbol}</div>
                    <div style={{ fontSize: 10.5, color: "var(--text-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{NAMES[r.symbol]}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {r.signal ? (
                      <>
                        <span className={`chip ${r.signal.above ? "chip-long" : "chip-flat"}`}>{r.signal.above ? "SOPRA" : "SOTTO"}</span>
                        <div className="mono" style={{ fontSize: 11.5, color: "var(--text-secondary-2)", whiteSpace: "nowrap" }}>
                          {r.signal.distancePct >= 0 ? "+" : "−"}
                          {dec(Math.abs(r.signal.distancePct), 1)}% · vol {dec(r.signal.volPct, 0)}%
                        </div>
                      </>
                    ) : (
                      <div className="mono" style={{ fontSize: 11.5, color: "var(--text-faint)" }}>—</div>
                    )}
                  </div>
                  <div className="mono" style={{ fontSize: 12, textAlign: "right", color: "var(--text-secondary-2)" }}>{r.targetWeightPct > 0 ? `${dec(r.targetWeightPct, 1)}%` : "—"}</div>
                  <div className="mono" style={{ fontSize: 12, textAlign: "right" }}>{r.qty > 0 ? `${dec(r.weightPct, 1)}%` : "—"}</div>
                  <div className="mono" style={{ fontSize: 12, textAlign: "right" }}>{r.qty > 0 ? r.qty.toLocaleString("it-IT") : "—"}</div>
                  <div className="mono" style={{ fontSize: 11.5, textAlign: "right", color: "var(--text-secondary-2)" }}>{r.entryPrice != null ? dec(r.entryPrice, 2) : "—"}</div>
                  <div className="mono" style={{ fontSize: 11.5, textAlign: "right" }}>{r.last != null ? dec(r.last, 2) : "—"}</div>
                  <div className="mono" style={{ fontSize: 12.5, textAlign: "right", color: pnlColor(r.unrealized) }}>{r.qty > 0 ? money(r.unrealized) : "—"}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 18, alignItems: "start" }}>
          <div className="card" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 15, fontWeight: 500 }}>Come funziona</div>
            <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 7, fontSize: 12.5, lineHeight: 1.5, color: "var(--text-secondary)" }}>
              <li>Un ETF si tiene solo se la sua ultima chiusura è sopra la media delle 200 sedute precedenti; altrimenti resta liquidità. Solo long, nessuna leva.</li>
              <li>I pesi sono inversi alla volatilità a 63 sedute e scalati per una volatilità di portafoglio del 10% annuo (esposizione massima 100%).</li>
              <li>Si ribilancia una volta al mese, alla prima seduta, sulle chiusure della seduta precedente. Una posizione si tocca solo se la quantità obiettivo cambia di oltre il 20%.</li>
              <li>Le posizioni durano settimane: la regola di chiusura di fine giornata non vale per questo lab.</li>
              <li>Costo di esecuzione 0,023% per lato, come gli altri lab. Nessun ordine viene inviato al broker.</li>
            </ul>
          </div>
          <div className="card" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 15, fontWeight: 500 }}>Cosa dice il backtest (2017-2026, 9,7 anni)</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", columnGap: 14, rowGap: 6, alignItems: "baseline" }}>
              <div className="table-header-cell" />
              <div className="table-header-cell" style={{ textAlign: "right" }}>REND./ANNO</div>
              <div className="table-header-cell" style={{ textAlign: "right" }}>SHARPE</div>
              <div className="table-header-cell" style={{ textAlign: "right" }}>DD MAX</div>
              {[
                ["Trend ETF (questo lab)", "7,0%", "0,98", "9,9%"],
                ["60/40 SPY/IEF", "9,5%", "0,91", "21,2%"],
                ["SPY buy&hold", "15,0%", "0,87", "33,8%"],
              ].map(([n, a, b, c]) => (
                <div key={n} style={{ display: "contents" }}>
                  <div style={{ fontSize: 12.5 }}>{n}</div>
                  <div className="mono" style={{ fontSize: 12.5, textAlign: "right" }}>{a}</div>
                  <div className="mono" style={{ fontSize: 12.5, textAlign: "right" }}>{b}</div>
                  <div className="mono" style={{ fontSize: 12.5, textAlign: "right" }}>{c}</div>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 11.5, lineHeight: 1.5, color: "var(--text-faint)" }}>
              Simulazione storica, netta di costi, liquidità a rendimento zero. È in gran parte beta (premio al rischio) gestito per limitare il drawdown, non un vantaggio dimostrato: rende meno del buy&amp;hold in un decennio rialzista. Non è una promessa né una consulenza di investimento.
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function HeaderStat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div className="mono" style={{ fontSize: 9.5, letterSpacing: "0.12em", color: "var(--text-faint)", whiteSpace: "nowrap" }}>
        {label}
      </div>
      <div className="mono" style={{ fontSize: 13, fontWeight: 500, whiteSpace: "nowrap" }}>
        {value}
      </div>
    </div>
  );
}

function Kpi({ label, value, color, sub }: { label: string; value: string; color: string; sub: string }) {
  return (
    <div className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 7 }}>
      <div className="mono" style={{ fontSize: 9.5, letterSpacing: "0.11em", color: "var(--text-faint)", whiteSpace: "nowrap" }}>
        {label}
      </div>
      <div className="mono" style={{ fontSize: 24, fontWeight: 500, letterSpacing: "-0.02em", whiteSpace: "nowrap", color }}>
        {value}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-faint)" }}>{sub}</div>
    </div>
  );
}

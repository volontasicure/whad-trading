import { useEffect, useState } from "react";
import { StatusBadge } from "../components/StatusBadge";
import { dec, money, pnlColor } from "../data/mockData";
import { fetchTrend, type EtfLabsSnapshotView, type TrendSnapshotView } from "../lib/trend";
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
  BIL: "T-bill 1-3 mesi (liquidità)",
};

const PART_LABEL: Record<string, string> = { trend: "LAB D · trend ETF", rotation: "LAB E · rotazione ETF", pairs: "LAB B · pairs (sovrapposto)" };

const COLS = "minmax(150px, 1.5fr) minmax(150px, 1.3fr) minmax(70px, 0.8fr) minmax(70px, 0.8fr) minmax(60px, 0.7fr) minmax(80px, 0.9fr) minmax(80px, 0.9fr) minmax(80px, 0.9fr)";

type LabId = "trend" | "rotation";

function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("it-IT", { month: "long", year: "numeric" });
}

const pct = (v: number, digits = 1) => `${v >= 0 ? "+" : "−"}${dec(Math.abs(v), digits)}%`;

export function TrendView() {
  const [data, setData] = useState<EtfLabsSnapshotView | null>(null);
  const [status, setStatus] = useState<DataStatus>("loading");
  const [lab, setLab] = useState<LabId>("trend");

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

  const core = data?.core;
  const snap: TrendSnapshotView | undefined = data?.[lab];
  const params = data?.params;

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
          <div className="view-kicker">LAB D + LAB E + LAB B · SOLO SIMULAZIONE, NESSUN ORDINE REALE</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div className="view-title">Portafoglio proposto</div>
            {status === "live" ? (
              // Non "REALE": qui i dati sono veri ma il portafoglio è simulato, per non confonderli con il conto reale.
              <div className="mono" title="Posizioni dal database del lab, prezzi dal mercato" style={{ fontSize: 8.5, letterSpacing: "0.08em", padding: "2px 5px", borderRadius: 4, whiteSpace: "nowrap", background: "var(--fill-neutral)", color: "var(--text-faint)" }}>
                DATI LAB
              </div>
            ) : (
              <StatusBadge status={status} title={status === "offline" ? "Stato dei lab ETF non raggiungibile" : "Caricamento"} />
            )}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "stretch", gap: 22, flexWrap: "wrap" }}>
          <HeaderStat label="COMPOSIZIONE" value="50% D + 50% E + pairs 1×" />
          <HeaderStat label="PARAMETRI" value={params ? params.version : "—"} />
          <HeaderStat label="RIBILANCIAMENTO" value="mensile" />
        </div>
      </div>

      <div style={{ padding: "22px 30px 40px", display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
          <Kpi
            label="EQUITY PORTAFOGLIO"
            value={core?.startedAt ? `${Math.round(core.equity).toLocaleString("it-IT")} $` : "—"}
            color="var(--text-primary)"
            sub={core?.startedAt ? `su 100.000 $, dal ${new Date(core.startedAt).toLocaleDateString("it-IT")}` : "parte al primo ribilanciamento di entrambi i lab ETF"}
          />
          <Kpi
            label="P&L DALLA PARTENZA"
            value={core?.startedAt ? money(core.pnl) : "—"}
            color={core?.startedAt ? pnlColor(core.pnl) : "var(--text-faint)"}
            sub={core?.startedAt ? `${pct(core.pnlPct, 2)} · netto di costi` : ""}
          />
          <Kpi
            label="ESPOSIZIONE LORDA"
            value={core ? `${dec(core.grossPct, 0)}%` : "—"}
            color={core && core.grossPct > 180 ? "var(--red-ink)" : "var(--text-primary)"}
            sub="core ETF + gambe del pairs; limite di margine 200%"
          />
          <Kpi
            label="PROSSIMO RIBILANCIAMENTO"
            value={data?.trend.lastRebalance ? monthLabel(data.trend.nextRebalanceMonth) : data ? "al primo avvio" : "—"}
            color="var(--text-primary)"
            sub="prima seduta del mese, chiusure della seduta precedente"
          />
        </div>

        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ padding: "15px 18px", borderBottom: "1px solid var(--border-divider)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div style={{ fontSize: 15, fontWeight: 500 }}>Da dove viene il risultato</div>
            <div className="mono" style={{ fontSize: 10, letterSpacing: "0.1em", color: "var(--text-faint)" }}>
              P&amp;L DI OGNI LAB DALLA PARTENZA × PESO
            </div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <div style={{ minWidth: 520 }}>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(200px, 2fr) repeat(3, minmax(90px, 1fr))", alignItems: "center", padding: "0 18px", height: 34, background: "var(--bg-subtle)", borderBottom: "1px solid var(--border-divider)" }}>
                <div className="table-header-cell">LAB</div>
                <div className="table-header-cell" style={{ textAlign: "right" }}>P&amp;L LAB</div>
                <div className="table-header-cell" style={{ textAlign: "right" }}>PESO</div>
                <div className="table-header-cell" style={{ textAlign: "right" }}>CONTRIBUTO</div>
              </div>
              {(core?.parts ?? []).map((p) => (
                <div key={p.strategyId} style={{ display: "grid", gridTemplateColumns: "minmax(200px, 2fr) repeat(3, minmax(90px, 1fr))", alignItems: "center", padding: "0 18px", height: 42, borderBottom: "1px solid var(--border-subtle)" }}>
                  <div style={{ fontSize: 12.5 }}>{PART_LABEL[p.strategyId] ?? p.strategyId}</div>
                  <div className="mono" style={{ fontSize: 12, textAlign: "right", color: core?.startedAt ? pnlColor(p.pnl) : "var(--text-faint)" }}>{core?.startedAt ? money(p.pnl) : "—"}</div>
                  <div className="mono" style={{ fontSize: 12, textAlign: "right", color: "var(--text-secondary-2)" }}>{p.weight === 1 ? "1×" : `${dec(p.weight * 100, 0)}%`}</div>
                  <div className="mono" style={{ fontSize: 12.5, textAlign: "right", color: core?.startedAt ? pnlColor(p.contribution) : "var(--text-faint)" }}>{core?.startedAt ? money(p.contribution) : "—"}</div>
                </div>
              ))}
              {!core && <div style={{ padding: "18px", fontSize: 12.5, color: "var(--text-faint)" }}>{status === "offline" ? "Stato non raggiungibile." : "Caricamento…"}</div>}
            </div>
          </div>
        </div>

        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ padding: "15px 18px", borderBottom: "1px solid var(--border-divider)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div style={{ display: "flex", gap: 6 }}>
              {(["trend", "rotation"] as LabId[]).map((id) => (
                <div key={id} className={`pill${lab === id ? " active" : ""}`} onClick={() => setLab(id)}>
                  {id === "trend" ? "LAB D · trend" : "LAB E · rotazione"}
                </div>
              ))}
            </div>
            {snap && (
              <div className="mono" style={{ fontSize: 11, color: "var(--text-secondary-2)", display: "flex", gap: 14, flexWrap: "wrap" }}>
                <span>
                  equity {Math.round(snap.equity).toLocaleString("it-IT")} $ <span style={{ color: pnlColor(snap.pnl) }}>({money(snap.pnl)})</span>
                </span>
                <span>ETF {dec(100 - snap.billsPct - snap.cashPct, 0)}% · T-bill {dec(snap.billsPct, 0)}%</span>
              </div>
            )}
          </div>
          <div style={{ overflowX: "auto" }}>
            <div style={{ minWidth: 880 }}>
              <div style={{ display: "grid", gridTemplateColumns: COLS, alignItems: "center", padding: "0 18px", height: 34, background: "var(--bg-subtle)", borderBottom: "1px solid var(--border-divider)" }}>
                <div className="table-header-cell">ETF</div>
                <div className="table-header-cell">
                  {lab === "trend" ? `SEGNALE (MEDIA ${params?.trend.smaDays ?? "—"} SEDUTE)` : `MOMENTUM (${params?.rotation.months.join("-") ?? "—"} MESI)`}
                </div>
                <div className="table-header-cell" style={{ textAlign: "right" }}>PESO OBIETT.</div>
                <div className="table-header-cell" style={{ textAlign: "right" }}>PESO ORA</div>
                <div className="table-header-cell" style={{ textAlign: "right" }}>AZIONI</div>
                <div className="table-header-cell" style={{ textAlign: "right" }}>MEDIO</div>
                <div className="table-header-cell" style={{ textAlign: "right" }}>ULTIMO</div>
                <div className="table-header-cell" style={{ textAlign: "right" }}>UNREAL.</div>
              </div>
              {snap && !snap.lastRebalance && (
                <div style={{ padding: "22px 18px", fontSize: 12.5, color: "var(--text-faint)" }}>Nessun dato ancora: il primo ribilanciamento avviene alla prima esecuzione a mercato aperto.</div>
              )}
              {snap?.lastRebalance &&
                [...snap.rows]
                  .sort((a, b) => (a.symbol === "BIL" ? 1 : b.symbol === "BIL" ? -1 : 0) || b.weightPct - a.weightPct || b.targetWeightPct - a.targetWeightPct || (a.score?.rank ?? 99) - (b.score?.rank ?? 99))
                  .map((r) => (
                    <div key={r.symbol} className="row-hover" style={{ display: "grid", gridTemplateColumns: COLS, alignItems: "center", padding: "0 18px", height: 46, borderBottom: "1px solid var(--border-subtle)" }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                        <div className="mono" style={{ fontSize: 12.5, fontWeight: 500 }}>{r.symbol}</div>
                        <div style={{ fontSize: 10.5, color: "var(--text-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{NAMES[r.symbol]}</div>
                      </div>
                      <SignalCell lab={lab} row={r} cashScorePct={snap.cashScorePct} />
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
          {snap?.lastRebalance && (
            <div style={{ padding: "10px 18px", fontSize: 11, color: "var(--text-faint)" }}>
              Ultimo ribilanciamento il {new Date(snap.lastRebalance.date).toLocaleDateString("it-IT")}: {snap.lastRebalance.closes} chiuse, {snap.lastRebalance.opens} aperte · realizzato netto {money(snap.realizedNet)} · aperto {money(snap.unrealized)}
            </div>
          )}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 18, alignItems: "start" }}>
          <div className="card" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 15, fontWeight: 500 }}>Come funziona</div>
            <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 7, fontSize: 12.5, lineHeight: 1.5, color: "var(--text-secondary)" }}>
              <li>
                <b>LAB D, trend:</b> un ETF si tiene solo se la sua chiusura è sopra la media delle {params?.trend.smaDays ?? "—"} sedute; pesi inversi alla volatilità, scalati per una volatilità di portafoglio del {params ? dec(params.trend.targetVol * 100, 0) : "—"}% annuo.
              </li>
              <li>
                <b>LAB E, rotazione:</b> si tengono i {params?.rotation.topK ?? "—"} ETF con il rendimento medio migliore su {params?.rotation.months.join(", ") ?? "—"} mesi, a peso uguale, solo se battono i T-bill.
              </li>
              <li>In entrambi la quota non investita va in T-bill (BIL), solo long, nessuna leva. Ribilanciamento alla prima seduta del mese; una posizione si tocca solo se la quantità cambia di oltre il 20%.</li>
              <li>Parametri scelti in walk-forward (solo sugli anni precedenti) e ricalibrati ogni gennaio, mai a metà anno.</li>
              <li>Portafoglio proposto = 50% LAB D + 50% LAB E + il P&amp;L del LAB B (pairs) sovrapposto 1×, che si autofinanzia con le vendite allo scoperto.</li>
              <li>Costo 0,023% per lato come gli altri lab. Nessun ordine viene inviato al broker.</li>
            </ul>
          </div>
          <div className="card" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 15, fontWeight: 500 }}>Cosa dice il backtest (2019-2026, fuori campione)</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", columnGap: 14, rowGap: 6, alignItems: "baseline" }}>
              <div className="table-header-cell" />
              <div className="table-header-cell" style={{ textAlign: "right" }}>REND./ANNO</div>
              <div className="table-header-cell" style={{ textAlign: "right" }}>SHARPE*</div>
              <div className="table-header-cell" style={{ textAlign: "right" }}>DD MAX</div>
              {[
                ["Portafoglio proposto", "13,8%", "1,10", "11,4%"],
                ["Solo core ETF (D + E)", "10,4%", "0,84", "11,8%"],
                ["Attuale: solo pairs", "3,0%", "0,11", "5,9%"],
                ["Originale: ORB+VWAP+pairs", "−2,3%", "−1,60", "20,3%"],
                ["SPY buy&hold", "17,3%", "0,80", "33,8%"],
                ["60/40 SPY/IEF", "10,8%", "0,73", "21,2%"],
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
              * Sul rendimento in eccesso dei T-bill. Simulazione storica netta di costi (scripts/redesign-test.ts). È in gran parte premio al rischio gestito (correlazione con SPY 0,53), non un vantaggio dimostrato: rende meno di SPY nei mercati in forte rialzo; il valore è il drawdown più basso (2022: +7% contro −18%). Una sola storia di mercato. Non è una promessa né una consulenza di investimento.
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function SignalCell({ lab, row, cashScorePct }: { lab: LabId; row: EtfLabsSnapshotView["trend"]["rows"][number]; cashScorePct: number | null }) {
  if (row.symbol === "BIL") return <div className="mono" style={{ fontSize: 11.5, color: "var(--text-faint)" }}>{lab === "rotation" && cashScorePct != null ? `soglia ${pct(cashScorePct)}` : "quota non investita"}</div>;
  if (lab === "trend") {
    if (!row.signal) return <div className="mono" style={{ fontSize: 11.5, color: "var(--text-faint)" }}>—</div>;
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className={`chip ${row.signal.above ? "chip-long" : "chip-flat"}`}>{row.signal.above ? "SOPRA" : "SOTTO"}</span>
        <div className="mono" style={{ fontSize: 11.5, color: "var(--text-secondary-2)", whiteSpace: "nowrap" }}>
          {pct(row.signal.distancePct)} · vol {dec(row.signal.volPct, 0)}%
        </div>
      </div>
    );
  }
  if (!row.score) return <div className="mono" style={{ fontSize: 11.5, color: "var(--text-faint)" }}>—</div>;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span className={`chip ${row.score.selected ? "chip-long" : "chip-flat"}`}>#{row.score.rank}</span>
      <div className="mono" style={{ fontSize: 11.5, color: "var(--text-secondary-2)", whiteSpace: "nowrap" }}>{pct(row.score.scorePct)}</div>
    </div>
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

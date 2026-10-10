// Varianti VWAP valutate AL NETTO dei costi di esecuzione (10/10/2026). Tutte con
// EXP_VWAP_TREND=0 = la configurazione di PRODUZIONE (filtro di trend spento): il backtest di
// default lo tiene acceso, quindi i numeri VWAP storici non erano quelli della produzione.
// Netto = lordo − pct_per_lato × turnover (turnover = nozionale ingresso + uscita).
// Costo misurato sui fill reali: ~0,023% per lato. Le due finestre girano in parallelo.
// Uso: npx tsx scripts/vwap-costs-ab.mjs [giorni] [ancora1] [ancora2]
import { spawn } from "node:child_process";

const days = Number(process.argv[2]) || 130;
const anchors = { recente: process.argv[3] || "2026-10-10", fuori_campione: process.argv[4] || "2026-05-11" };
const COST = 0.00023;

const variants = [
  { name: "base (produzione, trend spento)", env: {} },
  { name: "estensione 1.6%", env: { EXP_VWAP_EXTENSION_PCT: "1.6" } },
  { name: "estensione 2.0%", env: { EXP_VWAP_EXTENSION_PCT: "2.0" } },
  { name: "estensione 2.5%", env: { EXP_VWAP_EXTENSION_PCT: "2.5" } },
  { name: "max hold 150 min", env: { EXP_VWAP_MAX_HOLD_MIN: "150" } },
  { name: "estensione 2.0% + hold 150", env: { EXP_VWAP_EXTENSION_PCT: "2.0", EXP_VWAP_MAX_HOLD_MIN: "150" } },
];

function run(env, anchor) {
  return new Promise((resolve, reject) => {
    const p = spawn("npx", ["tsx", "scripts/backtest.ts", String(days), anchor], {
      env: { ...process.env, EXP_VWAP_TREND: "0", ...env },
      shell: true,
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`backtest fallito (${code}): ${err || out}`))));
  });
}

function parseVwap(out) {
  const m = out.match(/^vwap: (\d+) entrate, (\d+) uscite, P&L realizzato = (-?\d+)/m);
  const t = out.match(/^turnover vwap: (\d+)/m);
  return m && t ? { entries: Number(m[1]), gross: Number(m[3]), turnover: Number(t[1]) } : null;
}

const rows = [];
for (const v of variants) {
  console.log(`>>> ${v.name}...`);
  const [a, b] = await Promise.all([run(v.env, anchors.recente), run(v.env, anchors.fuori_campione)]);
  const r = { name: v.name, recente: parseVwap(a), oos: parseVwap(b) };
  rows.push(r);
  console.log(`    recente=${JSON.stringify(r.recente)} oos=${JSON.stringify(r.oos)}`);
}

const net = (x, pct = COST) => Math.round(x.gross - pct * x.turnover);
console.log("\n=== VWAP, produzione (trend spento): lordo / netto a 0,023%/lato — recente | fuori campione ===");
console.log("variante".padEnd(36), "lordo".padStart(15), "netto@0.023".padStart(16), "netto@0.015".padStart(16), "entrate".padStart(12));
for (const r of rows) {
  console.log(
    r.name.padEnd(36),
    `${r.recente.gross}/${r.oos.gross}`.padStart(15),
    `${net(r.recente)}/${net(r.oos)}`.padStart(16),
    `${net(r.recente, 0.00015)}/${net(r.oos, 0.00015)}`.padStart(16),
    `${r.recente.entries}/${r.oos.entries}`.padStart(12)
  );
}

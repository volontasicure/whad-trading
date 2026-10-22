// Scarica su disco (una volta) la storia SIP necessaria a rigiocare il backtest di produzione dal 2016:
// barre a 5 minuti dei 40 titoli per ogni seduta (stesso formato e stesso nome di file della cache di
// scripts/backtest.ts, solo le barre della sessione regolare) e le barre giornaliere rettificate split/spin-off
// (daily_bars_all.json, al posto della tabella daily_bars del DB). Zero query al database di produzione.
// Il feed IEX (quello del backtest standard) non ha barre intraday prima del 2021; SIP sì, dal 2016.
// Una richiesta per seduta (le richieste su più giorni scaricano anche le barre fuori orario, ~2,5 volte tanto),
// 4 richieste in parallelo con un ritmo comune sotto il limite di Alpaca (200 al minuto); su 429 attende il reset.
// Uso: npx tsx scripts/prefetch-sip-history.ts <cacheDir> [dal=2016-01-04] [al=2026-10-12]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { UNIVERSE_SYMBOLS } from "../server/universe.js";
import { etWallClockToUtcIso } from "../server/marketHours.js";

for (const l of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)="?(.*?)"?$/);
  if (m) process.env[m[1]] ??= m[2];
}
const H = { "APCA-API-KEY-ID": process.env.ALPACA_API_KEY_ID!, "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET_KEY! };
const [cacheDir, from = "2016-01-04", to = "2026-10-12"] = process.argv.slice(2);
if (!cacheDir) throw new Error("manca cacheDir");
mkdirSync(cacheDir, { recursive: true });

let nextSlot = 0;
let pausedUntil = 0;
async function get(url: string): Promise<any> {
  for (;;) {
    const now = Date.now();
    const slot = Math.max(nextSlot, now, pausedUntil);
    nextSlot = slot + 320; // ~187 richieste al minuto in tutto, condivise tra i lavoratori
    if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
    const res = await fetch(url, { headers: H });
    if (res.status === 429) {
      const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
      pausedUntil = Math.max(pausedUntil, Number.isFinite(reset) && reset > Date.now() ? reset + 250 : Date.now() + 3000);
      continue;
    }
    if (res.status >= 500) {
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.json();
  }
}
async function paginated(base: string) {
  const out: Record<string, any[]> = {};
  let token: string | null = null;
  for (;;) {
    const j = await get(base + (token ? `&page_token=${encodeURIComponent(token)}` : ""));
    for (const [s, a] of Object.entries(j.bars ?? {})) (out[s] ??= []).push(...(a as any[]));
    token = j.next_page_token ?? null;
    if (!token) return out;
  }
}

// giornaliere
const dailyFile = path.join(cacheDir, "daily_bars_all.json");
if (!existsSync(dailyFile)) {
  const d = await paginated(
    `https://data.alpaca.markets/v2/stocks/bars?symbols=${UNIVERSE_SYMBOLS.join(",")}&timeframe=1Day&limit=10000&feed=sip&adjustment=split,spin-off&sort=asc&start=2015-01-01T00:00:00Z&end=${to}T23:59:59Z`
  );
  const out: Record<string, { t: string; h: number; l: number; c: number }[]> = {};
  for (const s of UNIVERSE_SYMBOLS) out[s] = (d[s] ?? []).map((b) => ({ t: b.t.slice(0, 10), h: b.h, l: b.l, c: b.c }));
  writeFileSync(dailyFile, JSON.stringify(out));
  console.log("giornaliere:", UNIVERSE_SYMBOLS.map((s) => `${s}:${out[s].length}`).join(" "));
}

// intraday per seduta
const cal: { date: string; open: string; close: string }[] = await get(`https://paper-api.alpaca.markets/v2/calendar?start=${from}&end=${to}`);
const todo = cal
  .map((c) => {
    const openUtc = etWallClockToUtcIso(c.date, c.open);
    const closeUtc = etWallClockToUtcIso(c.date, c.close);
    const file = path.join(cacheDir, `${openUtc.replace(/[^0-9A-Za-z]/g, "")}_${closeUtc.replace(/[^0-9A-Za-z]/g, "")}_${UNIVERSE_SYMBOLS.length}.json`);
    return { date: c.date, openUtc, closeUtc, file };
  })
  .filter((s) => !existsSync(s.file));
console.log(`${cal.length} sedute, ${todo.length} da scaricare`);
let i = 0, done = 0;
const t0 = Date.now();
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (i < todo.length) {
      const s = todo[i++];
      const m = await paginated(
        `https://data.alpaca.markets/v2/stocks/bars?symbols=${UNIVERSE_SYMBOLS.join(",")}&timeframe=5Min&limit=10000&feed=sip&adjustment=split,spin-off&sort=asc&start=${encodeURIComponent(s.openUtc)}&end=${encodeURIComponent(s.closeUtc)}`
      );
      const out: Record<string, any[]> = {};
      for (const sym of UNIVERSE_SYMBOLS) out[sym] = (m[sym] ?? []).filter((b) => b.t < s.closeUtc); // solo sessione regolare, come il feed IEX
      writeFileSync(s.file, JSON.stringify(out));
      if (++done % 100 === 0) console.log(`${done}/${todo.length} (${s.date}) — ${((done / (Date.now() - t0)) * 60000).toFixed(0)} sedute/min`);
    }
  })
);
console.log(`fatto: ${done} sedute scaricate`);

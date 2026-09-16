// Backfill una tantum delle barre giornaliere storiche in daily_bars, da lanciare a mano
// (`npm run db:backfill-bars` oppure `node scripts/backfill-daily-bars.mjs [giorni]`) prima
// di affidarsi allo storico per un'analisi. Da quel momento in poi api/cron/tick.ts continua
// ad aggiungere le barre giornaliere nuove ogni volta che le scarica per ATR/pairs trading.
//
// Riusa lo stesso pattern di scripts/migrate.mjs per caricare .env.local; duplica
// UNIVERSE_SYMBOLS (come già fa server/universe.ts) perché questo è uno script Node
// standalone, non un bundle Vite.

import { readFileSync } from "node:fs";
import path from "node:path";
import { neon } from "@neondatabase/serverless";

function loadEnvLocal() {
  const p = path.resolve(process.cwd(), ".env.local");
  let content;
  try {
    content = readFileSync(p, "utf8");
  } catch {
    return;
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvLocal();

const UNIVERSE_SYMBOLS = [
  "AAPL", "MSFT", "NVDA", "GOOGL", "META", "TXN", "AVGO", "ORCL", "CRM",
  "JPM", "BAC", "V", "MA", "WFC", "GS",
  "XOM", "CVX", "COP", "SLB",
  "KO", "PEP", "PG", "WMT", "COST",
  "UNH", "JNJ", "ABBV", "LLY", "MRK", "TMO",
  "CAT", "HON", "LIN", "BA", "GE",
  "AMZN", "HD", "MCD", "NKE", "SBUX",
];

const connectionString = process.env.POSTGRES_URL;
if (!connectionString) {
  console.error("POSTGRES_URL non trovata (esegui prima `vercel env pull .env.local`).");
  process.exit(1);
}

const keyId = process.env.ALPACA_API_KEY_ID;
const secretKey = process.env.ALPACA_API_SECRET_KEY;
if (!keyId || !secretKey) {
  console.error("ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY mancanti in .env.local.");
  process.exit(1);
}

const days = Number(process.argv[2]) || 730;
const sql = neon(connectionString);

/**
 * Con molti simboli e molti giorni la risposta multi-simbolo di Alpaca non entra in una
 * sola pagina: torna solo un sottoinsieme di simboli/barre più un next_page_token. Senza
 * seguire la paginazione fino in fondo, metà dei simboli risultano silenziosamente senza
 * barre — scoperto allargando l'universo da 20 a 40 titoli.
 */
async function fetchDailyBars(symbols, start) {
  const merged = {};
  let pageToken = null;
  do {
    const url =
      `https://data.alpaca.markets/v2/stocks/bars?symbols=${encodeURIComponent(symbols.join(","))}` +
      `&timeframe=1Day&limit=10000&feed=iex&sort=asc&start=${encodeURIComponent(start)}` +
      (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : "");
    const res = await fetch(url, { headers: { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secretKey } });
    if (!res.ok) throw new Error(`Alpaca GET bars -> ${res.status} ${await res.text().catch(() => "")}`);
    const body = await res.json();
    for (const [symbol, bars] of Object.entries(body.bars ?? {})) {
      (merged[symbol] ??= []).push(...bars);
    }
    pageToken = body.next_page_token ?? null;
  } while (pageToken);
  return merged;
}

async function saveDailyBars(rows) {
  if (rows.length === 0) return;
  const values = [];
  const params = [];
  rows.forEach((r, i) => {
    const base = i * 7;
    values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7})`);
    params.push(r.symbol, r.tradingDate, r.open, r.high, r.low, r.close, r.volume);
  });
  await sql.query(
    `INSERT INTO daily_bars (symbol, trading_date, open, high, low, close, volume)
     VALUES ${values.join(",")}
     ON CONFLICT (symbol, trading_date) DO UPDATE SET
       open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
       close = EXCLUDED.close, volume = EXCLUDED.volume`,
    params
  );
}

const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
console.log(`Scarico ${days} giorni di barre giornaliere per ${UNIVERSE_SYMBOLS.length} simboli da Alpaca (feed IEX)...`);
const bars = await fetchDailyBars(UNIVERSE_SYMBOLS, start);

let totalRows = 0;
for (const symbol of UNIVERSE_SYMBOLS) {
  const symbolBars = bars[symbol] ?? [];
  if (symbolBars.length === 0) {
    console.warn(`  ${symbol}: nessuna barra restituita, salto.`);
    continue;
  }
  const rows = symbolBars.map((b) => ({
    symbol,
    tradingDate: b.t.slice(0, 10),
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    volume: b.v,
  }));
  await saveDailyBars(rows);
  totalRows += rows.length;
  console.log(`  ${symbol}: ${rows.length} barre (${rows[0].tradingDate} -> ${rows[rows.length - 1].tradingDate})`);
}

console.log(`Backfill completato: ${totalRows} barre totali salvate in daily_bars.`);

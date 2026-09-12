import { alpacaFetch } from "./alpaca.js";

export interface MarketSession {
  openUtc: string;
  closeUtc: string;
}

interface CalendarEntry {
  date: string;
  open: string;
  close: string;
}

function getOffsetMinutes(timeZone: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) if (p.type !== "literal") parts[p.type] = p.value;
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return (asUTC - date.getTime()) / 60_000;
}

/** Converte un orario locale "HH:MM" di New York in una data specifica in un ISO UTC preciso (gestisce l'ora legale). */
export function etWallClockToUtcIso(dateIso: string, hhmm: string): string {
  const [hh, mm] = hhmm.includes(":") ? hhmm.split(":") : [hhmm.slice(0, 2), hhmm.slice(2)];
  const guessUtc = new Date(`${dateIso}T${hh.padStart(2, "0")}:${mm.padStart(2, "0")}:00.000Z`);
  const offsetMin = getOffsetMinutes("America/New_York", guessUtc);
  return new Date(guessUtc.getTime() - offsetMin * 60_000).toISOString();
}

/**
 * Orario di apertura/chiusura regolare (esclude pre-market e after-hours) per una data,
 * via il calendario reale di Alpaca — niente ipotesi fisse su UTC/ora legale.
 * Ritorna null se la data non è un giorno di borsa (weekend/festivo).
 */
export async function fetchMarketSession(dateIso: string): Promise<MarketSession | null> {
  const cal = await alpacaFetch<CalendarEntry[]>(`/v2/calendar?start=${dateIso}&end=${dateIso}`);
  const entry = cal[0];
  if (!entry) return null;
  return { openUtc: etWallClockToUtcIso(dateIso, entry.open), closeUtc: etWallClockToUtcIso(dateIso, entry.close) };
}

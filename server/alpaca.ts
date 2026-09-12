const PAPER_BASE = "https://paper-api.alpaca.markets";
const LIVE_BASE = "https://api.alpaca.markets";
/** Host dei market data: unico per paper e live, l'ambiente conta solo per il trading. */
const DATA_BASE = "https://data.alpaca.markets";

export type AlpacaEnvironment = "paper" | "live";

interface Credentials {
  keyId: string;
  secretKey: string;
  environment: AlpacaEnvironment;
  baseUrl: string;
}

export class AlpacaNotConfiguredError extends Error {
  constructor() {
    super("Chiavi Alpaca non configurate (ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY mancanti).");
    this.name = "AlpacaNotConfiguredError";
  }
}

function credentials(): Credentials | null {
  const keyId = process.env.ALPACA_API_KEY_ID;
  const secretKey = process.env.ALPACA_API_SECRET_KEY;
  if (!keyId || !secretKey) return null;
  const environment: AlpacaEnvironment = process.env.ALPACA_ENV === "live" ? "live" : "paper";
  return { keyId, secretKey, environment, baseUrl: environment === "live" ? LIVE_BASE : PAPER_BASE };
}

export function requireCredentials(): Credentials {
  const creds = credentials();
  if (!creds) throw new AlpacaNotConfiguredError();
  return creds;
}

async function alpacaFetchFrom<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const creds = requireCredentials();
  const res = await fetch(baseUrl + path, {
    ...init,
    headers: {
      "APCA-API-KEY-ID": creds.keyId,
      "APCA-API-SECRET-KEY": creds.secretKey,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Alpaca ${init?.method ?? "GET"} ${path} -> ${res.status} ${body}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Chiamata autenticata alla Trading API di Alpaca (paper o live). Le chiavi non lasciano mai il server. */
export function alpacaFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const creds = requireCredentials();
  return alpacaFetchFrom<T>(creds.baseUrl, path, init);
}

/** Chiamata autenticata alla Market Data API di Alpaca (prezzi/quotazioni, indipendente da paper/live). */
export function alpacaDataFetch<T>(path: string, init?: RequestInit): Promise<T> {
  return alpacaFetchFrom<T>(DATA_BASE, path, init);
}

/** Maschera una API key id mostrando prefisso e ultimi 4 caratteri, come in "PK••••••••••7F2C". */
export function maskKeyId(keyId: string): string {
  if (keyId.length <= 6) return "•".repeat(keyId.length);
  const prefix = keyId.slice(0, 2);
  return `${prefix}${"•".repeat(10)}${keyId.slice(-4)}`;
}

export function currentCredentialsSafe(): { environment: AlpacaEnvironment; maskedKey: string } | null {
  const creds = credentials();
  if (!creds) return null;
  return { environment: creds.environment, maskedKey: maskKeyId(creds.keyId) };
}

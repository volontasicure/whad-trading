const PAPER_BASE = "https://paper-api.alpaca.markets";
const LIVE_BASE = "https://api.alpaca.markets";

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

/** Chiamata autenticata all'API REST di Alpaca. Le chiavi non lasciano mai il server. */
export async function alpacaFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const creds = requireCredentials();
  const res = await fetch(creds.baseUrl + path, {
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

/** Maschera una API key id mostrando solo gli ultimi 4 caratteri, come in "PK••••••••••7F2C". */
export function maskKeyId(keyId: string): string {
  if (keyId.length <= 4) return "•".repeat(keyId.length);
  return "•".repeat(keyId.length - 4) + keyId.slice(-4);
}

export function currentCredentialsSafe(): { environment: AlpacaEnvironment; maskedKey: string } | null {
  const creds = credentials();
  if (!creds) return null;
  return { environment: creds.environment, maskedKey: maskKeyId(creds.keyId) };
}

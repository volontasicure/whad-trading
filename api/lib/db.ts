import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

let client: NeonQueryFunction<false, false> | null = null;

/** Client Neon HTTP — nessun pool da gestire, adatto alle funzioni serverless. Inizializzato al primo uso. */
export function db(): NeonQueryFunction<false, false> {
  if (!client) {
    const url = process.env.POSTGRES_URL;
    if (!url) throw new Error("POSTGRES_URL non configurata (database non collegato).");
    client = neon(url);
  }
  return client;
}

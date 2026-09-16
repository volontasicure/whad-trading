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

const connectionString = process.env.POSTGRES_URL;
if (!connectionString) {
  console.error("POSTGRES_URL non trovata (esegui prima `vercel env pull .env.local`).");
  process.exit(1);
}

const sql = neon(connectionString);
const schema = readFileSync(path.resolve(process.cwd(), "db/schema.sql"), "utf8");

// Toglie i commenti "-- ..." PRIMA di dividere sui ";": un commento SQL può contenere un
// punto e virgola nel testo (es. "...#ExitDecision;") che altrimenti lo splitter naive
// scambierebbe per fine statement, troncando lo statement vero a metà.
const withoutComments = schema
  .split("\n")
  .map((line) => {
    const idx = line.indexOf("--");
    return idx === -1 ? line : line.slice(0, idx);
  })
  .join("\n");

const statements = withoutComments
  .split(/;\s*(?:\n|$)/)
  .map((s) => s.trim())
  .filter(Boolean);

for (const stmt of statements) {
  console.log("Eseguo:", stmt.replace(/\s+/g, " ").slice(0, 70) + "...");
  await sql.query(stmt);
}

console.log(`Migrazione completata (${statements.length} statement).`);

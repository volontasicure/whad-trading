-- Schema per lo stato reale dei laboratori e lo storico sedute.
-- Applicato manualmente con `node scripts/migrate.mjs` (vedi README).

CREATE TABLE IF NOT EXISTS lab_positions (
  id SERIAL PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  qty NUMERIC NOT NULL,
  entry_price NUMERIC NOT NULL,
  entry_time TIMESTAMPTZ NOT NULL DEFAULT now(),
  exit_price NUMERIC,
  exit_time TIMESTAMPTZ,
  realized_pnl NUMERIC,
  status TEXT NOT NULL DEFAULT 'open'
);

CREATE INDEX IF NOT EXISTS lab_positions_strategy_status_idx ON lab_positions (strategy_id, status);

-- Stato di lavoro intraday per strategia (range di apertura, VWAP accumulato, coppie selezionate, ecc.).
CREATE TABLE IF NOT EXISTS lab_state (
  strategy_id TEXT NOT NULL,
  trading_date DATE NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (strategy_id, trading_date, key)
);

-- Storico sedute reale (sostituirà a regime i dati finti in mockData.ts).
CREATE TABLE IF NOT EXISTS sessions (
  trading_date DATE PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  net NUMERIC NOT NULL,
  deviation_pct NUMERIC NOT NULL,
  trades INTEGER NOT NULL,
  costs NUMERIC NOT NULL
);

-- Log di ogni invocazione del tick, per verificare che lo scheduler GitHub Actions funzioni davvero.
CREATE TABLE IF NOT EXISTS tick_log (
  id SERIAL PRIMARY KEY,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  market_open BOOLEAN NOT NULL,
  note TEXT
);

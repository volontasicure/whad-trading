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
  status TEXT NOT NULL DEFAULT 'open',
  -- Collega le due gambe di una coppia (solo strategy_id = 'pairs'); NULL per le altre strategie.
  pair_key TEXT,
  -- Stop/target dell'ORB, sulla riga e non in una cache per data: una posizione che
  -- sopravvive oltre la giornata in cui è stata aperta non deve mai perderli.
  stop_price NUMERIC,
  target_price NUMERIC,
  -- Perché è stata chiusa: 'stop' | 'target' | 'stop_loss' | 'max_hold' | 'exit_target' | 'eod'
  -- (valori esatti per strategia in server/{orb,vwapReversion,pairsTrading}.ts#ExitDecision;
  -- 'eod' per le chiusure della rete di sicurezza generica/coppie, che non hanno un reason
  -- proprio). NULL per le posizioni ancora aperte. Diagnostica: senza questo, "3 chiuse,
  -- P&L -161" non dice se erano 3 stop o 3 target — non si distingue un filtro d'ingresso
  -- troppo permissivo (tanti stop) da normale rumore.
  exit_reason TEXT
);

ALTER TABLE lab_positions ADD COLUMN IF NOT EXISTS pair_key TEXT;
ALTER TABLE lab_positions ADD COLUMN IF NOT EXISTS stop_price NUMERIC;
ALTER TABLE lab_positions ADD COLUMN IF NOT EXISTS target_price NUMERIC;
ALTER TABLE lab_positions ADD COLUMN IF NOT EXISTS exit_reason TEXT;

CREATE INDEX IF NOT EXISTS lab_positions_strategy_status_idx ON lab_positions (strategy_id, status);
CREATE INDEX IF NOT EXISTS lab_positions_pair_key_idx ON lab_positions (pair_key) WHERE pair_key IS NOT NULL;

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

-- Barre giornaliere persistite (storico multi-giorno), per non dipendere solo dalla cache
-- effimera in lab_state e per avere dati disponibili ad analisi future (es. attribuzione
-- di performance). Scritte da api/cron/tick.ts quando già scarica barre giornaliere da
-- Alpaca per ATR/pairs trading, e dallo script una tantum scripts/backfill-daily-bars.mjs
-- per lo storico precedente al primo giorno di raccolta live.
CREATE TABLE IF NOT EXISTS daily_bars (
  symbol TEXT NOT NULL,
  trading_date DATE NOT NULL,
  open NUMERIC NOT NULL,
  high NUMERIC NOT NULL,
  low NUMERIC NOT NULL,
  close NUMERIC NOT NULL,
  volume NUMERIC NOT NULL,
  PRIMARY KEY (symbol, trading_date)
);

-- Barre a 5 minuti della sessione regolare, persistite tick dopo tick da api/cron/tick.ts
-- (le stesse barre già scaricate da Alpaca per VWAP/RSI/range di apertura, oggi scartate
-- dopo l'uso). Servono a ricostruire in seguito "cosa vedeva la strategia in quel momento".
CREATE TABLE IF NOT EXISTS session_bars (
  symbol TEXT NOT NULL,
  bar_time TIMESTAMPTZ NOT NULL,
  open NUMERIC NOT NULL,
  high NUMERIC NOT NULL,
  low NUMERIC NOT NULL,
  close NUMERIC NOT NULL,
  volume NUMERIC NOT NULL,
  vwap NUMERIC NOT NULL,
  PRIMARY KEY (symbol, bar_time)
);

-- Z-score intraday di ogni coppia candidata del giorno (non solo quelle che superano
-- ENTRY_Z), scritto ad ogni tick da api/cron/tick.ts. Diagnostica per pairs trading: senza
-- questo, un giorno senza nuovi ingressi non dice se le coppie sfioravano la soglia di 2,0
-- senza mai superarla, o se erano semplicemente poco correlate in pratica — due problemi
-- diversi con rimedi diversi (soglia troppo alta vs selezione delle coppie da rivedere).
CREATE TABLE IF NOT EXISTS pairs_zscore_log (
  id SERIAL PRIMARY KEY,
  trading_date DATE NOT NULL,
  pair_key TEXT NOT NULL,
  symbol_a TEXT NOT NULL,
  symbol_b TEXT NOT NULL,
  z NUMERIC NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pairs_zscore_log_date_pair_idx ON pairs_zscore_log (trading_date, pair_key);

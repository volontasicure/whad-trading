# WHAD Trading — istruzioni di progetto

Piattaforma **WHAD Trading**: tre strategie eseguite in parallelo su tre portafogli "laboratorio" identici, più un conto reale che ogni mattina, dopo un debriefing, adotta la strategia migliore per la giornata.

## Stato attuale

Frontend React + Vite + TypeScript con le 6 viste ricostruite fedelmente dal design handoff.

**Dati reali**: prezzi di mercato (`/api/market/quotes`, pollati ogni 20s) e conto reale (posizioni, P&L per periodo, esecuzioni via `useRealPortfolio`). I 3 laboratori restano **simulati** con la stessa logica deterministica del prototipo, ma ora girano sui prezzi reali invece che su uno snapshot fisso — non esiste ancora una logica di trading vera (ORB/pairs/VWAP reversion), quindi le posizioni "lab" non riflettono decisioni reali. Storico sedute, backtest e P&L per periodo dei lab restano dati finti (nessuna persistenza ancora).

**Nessuna scrittura automatica verso il broker**: "Conferma e attiva" nel debriefing aggiorna solo lo stato locale della UI, non chiama `submitOrder`. Deliberato: finché non esiste una logica di strategia reale, collegare l'invio ordini userebbe segnali finti spacciandoli per un algoritmo funzionante — vedi "Prossimi passi".

**Automazione**: chiusura EOD reale via Vercel Cron (`api/cron/eod-close.ts`, schedulato in `vercel.json`) — chiude le posizioni reali con unrealized positivo a ridosso della chiusura di mercato. Un secondo tick (`api/cron/tick.ts`) gira ogni 10 minuti in orario di mercato via GitHub Actions (`.github/workflows/tick.yml`, non Vercel Cron — troppo poco frequente sul piano Hobby): per ora è solo uno scheletro che verifica il market clock e scrive un log in `tick_log`, **non contiene ancora nessuna logica di strategia**.

**Database**: Postgres (Neon, collegato via marketplace Vercel). Schema in `db/schema.sql`, applicato con `npm run db:migrate` (richiede `.env.local` da `vercel env pull`). Tabelle: `lab_positions` (posizioni simulate per strategia), `lab_state` (indicatori intraday accumulati per strategia/giorno, es. range di apertura, VWAP), `sessions` (storico sedute reale — sostituirà `SESSIONS` in `mockData.ts`), `tick_log` (log delle invocazioni del tick, per verificare che lo scheduler giri davvero).

## Riferimenti di design

Il design handoff originale vive in `../Interfaccia trading multi-strategia/design_handoff_whad_trading/` (fuori da questo repo):
- `README.md` — specifica di design completa (viste, token, misure, interazioni). Fonte di verità per la UI.
- `screenshots/` — aspetto atteso di ogni vista.
- `WHAD Trading.dc.html` — prototipo HTML navigabile con la logica dei dati finti.
- `API.md` — modello dati e contratto dell'adapter broker.

## Struttura del codice

**Il codice server condiviso vive in `server/`, non in `api/lib/`**: Vercel (piano Hobby) conta ogni file `.ts` dentro `api/` come una funzione serverless a sé, incluso codice che non è una route (l'abbiamo scoperto quando `api/lib/*` ha fatto sforare il limite di 12 funzioni e bloccato un deploy). Solo i file con un handler route-abile vanno sotto `api/`; tutto ciò che è solo importato (client Alpaca, client DB, costanti condivise) va in `server/`.

- `src/types.ts` — interfacce del modello dati e contratto `BrokerAdapter` (da `API.md`).
- `src/data/mockData.ts` — dati finti deterministici (stessa logica hash del prototipo) + helper di formattazione (`money`, `dec`, `pnlColor`, `formatPnl`).
- `src/context/AppState.tsx` — stato condiviso: toggle Valore/%, conferma debriefing, countdown.
- `src/components/` — Sidebar, Header, TickerTape, Sparkline, PnlHistogram, PnlModeToggle.
- `src/views/` — una vista per file: `LabView`, `StrategyView`, `DebriefView`, `LiveView`, `HistoryView`, `RulesView`.
- `src/lib/brokerAdapters/alpaca.ts` — implementazione client di `BrokerAdapter`, chiama solo `/api/broker/*` (mai Alpaca direttamente dal browser).
- `src/lib/marketQuotes.ts` — fetch delle quotazioni reali (`/api/market/quotes`).
- `src/hooks/useAlpacaStatus.ts` — stato del broker, fallback silenzioso ai dati finti.
- `src/hooks/useRealPortfolio.ts` — posizioni/P&L/esecuzioni reali del conto Alpaca, fallback silenzioso ai dati finti.
- `src/context/AppState.tsx` — oltre allo stato UI, polla `/api/market/quotes` ogni 20s ed espone `liveMarket` (ricalcolato con `buildLiveMarketData` in `mockData.ts`) a tutte le viste.
- `api/broker/*.ts` — funzioni serverless Vercel che parlano con la Trading API di Alpaca usando le chiavi lato server (`server/alpaca.ts`).
- `api/market/quotes.ts` — legge gli snapshot reali dalla Market Data API di Alpaca (`server/alpaca.ts` → `alpacaDataFetch`, host `data.alpaca.markets`, separato dalla Trading API).
- `api/cron/eod-close.ts` — chiusura EOD reale, schedulata via Vercel Cron in `vercel.json`. Protetta da `CRON_SECRET` (Vercel la invia da sola come header `Authorization: Bearer` quando la variabile è impostata).
- `api/cron/tick.ts` — tick periodico (scheletro, vedi sopra), invocato da GitHub Actions. Protetto da `TICK_SECRET` (va impostato a mano sia su Vercel sia come secret del repo GitHub — nessun auto-injection qui, a differenza di `CRON_SECRET`).
- `server/db.ts` — client Neon condiviso (`db()`), lazy-init su `POSTGRES_URL`.
- `db/schema.sql` + `scripts/migrate.mjs` — schema e migrazione (locale, non automatica al deploy).
- Routing reale con `react-router-dom`: `/lab`, `/strategie/:id`, `/debriefing`, `/reale`, `/storico`, `/regole`.

### Adapter broker: cosa fa e cosa no

- **Alpaca Trading API**, non Broker API: un solo conto (il "conto reale"), niente onboarding di conti terzi. I 3 portafogli laboratorio restano simulati internamente — Alpaca non è pensato per più conti paralleli sotto le stesse chiavi.
- Implementato (sola lettura + scrittura non ancora collegata alla UI): `status`, `getPositions`, `marketClock`, `getExecutions`, `getRealizedPnl`, `submitOrder`, `closePosition`.
- **Limite noto**: `getRealizedPnl` usa la portfolio history di Alpaca (variazione di equity = realized + unrealized), non il solo realized "incassato" richiesto dalla spec — Alpaca non espone il realized per singolo fill via REST senza lot-matching. Da rifinire quando servirà precisione contabile.
- **Non implementato**: `streamQuotes` (richiede una connessione persistente, incompatibile con le funzioni serverless Vercel — serve un servizio a lunga esecuzione separato, vedi sotto).
- Variabili d'ambiente richieste (solo server-side, mai `VITE_*`): `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY`, `ALPACA_ENV` (`paper`/`live`), `CRON_SECRET` (per `api/cron/*`). Vedi `.env.example`.

### Cron EOD: limite noto sull'ora legale

`api/cron/eod-close.ts` gira una volta al giorno via Vercel Cron (piano Hobby: un solo orario UTC fisso, niente cron più frequenti). La chiusura NYSE (16:00 ET) cade a un'ora UTC diversa secondo l'ora legale USA (20:00 UTC in EDT, marzo-novembre; 21:00 UTC in EST, novembre-marzo). Lo schedule è tarato su EDT: nei mesi EST il mercato risulterà già chiuso quando il cron parte e la chiusura verrà saltata (la funzione verifica sempre `marketClock()` reale prima di agire, quindi salta in sicurezza invece di chiudere posizioni all'orario sbagliato). Per coprire entrambi i periodi servirebbe un cron più frequente (piano Pro) o uno scheduler timezone-aware esterno.

## Regole di dominio da non violare

1. I tre portafogli laboratorio hanno sempre **gli stessi titoli e lo stesso capitale**; l'unica variabile è la strategia.
2. La strategia si applica **a livello di portafoglio**, mai al singolo titolo.
3. A fine seduta **tutte le posizioni con unrealized positivo vengono chiuse** (regola disattivabile), sia nei lab sia sul conto reale.
4. Il numero di posizioni aperte non può superare il tetto dichiarato nei parametri della strategia.
5. `unrealized = qty × (last − avg)`, segno invertito sugli short. I totali devono quadrare a ispezione.
6. Il ranking del debriefing si calcola sul **netto delle ultime 20 sedute**; il badge "migliore oggi" sulle card lab è **intraday**. Etichettare sempre la base temporale di ogni numero.
7. La motivazione della strategia proposta dipende dalla strategia, non dalla sua posizione in classifica.

## Regole di UI

- Nessuna griglia in px fissi dentro contenitori fluidi: `minmax()` e `repeat(auto-fit, minmax(Npx, 1fr))`.
- Numeri, label maiuscole e codici in IBM Plex Mono; interfaccia in Helvetica.
- Nessuna ombra: la gerarchia è data da bordi e tre livelli di sfondo (`--bg-page` / `--bg-surface` / `--bg-subtle`).
- Verde `#15803d` / rosso `#b91c1c` riservati al P&L e agli stati; l'accento `#4ade80` a dot, barre e sparkline.
- Token CSS centralizzati in `src/index.css` (`:root`).

## Prossimi passi

1. **Logica reale delle 3 strategie** (ORB, pairs trading, VWAP reversion) — il pezzo più grosso rimasto, ora sbloccato (database + scheduler pronti in `api/cron/tick.ts`). Da fare per ognuna: dati storici intraday (barre a 1 min da Alpaca), regole di ingresso/uscita, persistenza in `lab_positions`/`lab_state`. Partire da una sola strategia per volta e validare prima di aggiungere le altre due — non tutte insieme.
2. Una volta che i lab hanno segnali reali: collegare "Conferma e attiva" a `submitOrder` per davvero, con conferma asincrona e stato di errore (oggi non progettato).
3. Debriefing serale automatico e `Storico` reale (popolare `sessions` da `lab_positions` invece dei mock in `mockData.ts`).
4. Lot-matching per il realized P&L preciso (vedi limite noto sopra).
5. `streamQuotes` via WebSocket Alpaca — richiede un servizio a lunga esecuzione separato, non funzioni serverless Vercel (il polling REST attuale ogni 20s è il sostituto pragmatico).
6. Stati ancora da progettare: loading, disconnessione API, mercato chiuso, stop di portafoglio scattato, conferma mancante a mercato aperto. Chiedere prima di inventarli.

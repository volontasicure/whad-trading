# WHAD Trading — istruzioni di progetto

Piattaforma **WHAD Trading**: tre strategie eseguite in parallelo su tre portafogli "laboratorio" identici, più un conto reale che ogni mattina, dopo un debriefing, adotta la strategia migliore per la giornata.

## Stato attuale

Frontend React + Vite + TypeScript con le 6 viste ricostruite fedelmente dal design handoff.

**Dati reali**: prezzi di mercato (`/api/market/quotes`, pollati ogni 20s) e conto reale (posizioni, P&L per periodo, esecuzioni via `useRealPortfolio`). **Tutte e tre le strategie hanno logica di trading reale** (vedi sotto). Il frontend legge le posizioni reali da `lab_positions` quando esistono (`api/lab/positions.ts` + `mergeRealLabData` in `mockData.ts`), strategia per strategia, con fallback automatico alla simulazione finché una strategia non ha ancora posizioni. Storico sedute, backtest e P&L per periodo restano dati finti (nessuna persistenza per quelli ancora).

**Nessuna scrittura automatica verso il broker reale**: "Conferma e attiva" nel debriefing aggiorna solo lo stato locale della UI, non chiama `submitOrder`. Deliberato: il sizing per il conto reale è "libero" (massimizzare il realized, non equal-weight come nei lab) ed è un pezzo di logica ancora da progettare — vedi "Prossimi passi".

**Automazione**: chiusura EOD reale via Vercel Cron (`api/cron/eod-close.ts`) per il conto reale, più una rete di sicurezza EOD generica per i lab dentro `tick.ts` (`server/labEod.ts`) — prima la regola valeva solo per il conto reale, violando la spec. Il tick principale (`api/cron/tick.ts`) gira **ogni minuto** in orario di mercato via GitHub Actions (`.github/workflows/tick.yml`, non Vercel Cron — troppo poco frequente sul piano Hobby) ed esegue **tutte e tre le strategie** ad ogni invocazione. Il repo è **pubblico** (uso solo personale, nessun piano di commercializzazione) proprio per avere minuti Actions illimitati a questa cadenza — su un repo privato il piano gratuito regge comodamente solo fino a ~10 minuti di cadenza (vedi cronologia dei commit per i conti). Sotto i 5 minuti GitHub esegue gli schedule "a impegno migliore": qualche tick può slittare o saltare, non è garantito un giro esatto ogni 60 secondi.

### Le tre strategie: come funzionano

- **VWAP reversion (LAB C)**, `server/vwapReversion.ts`: per ogni titolo senza posizione, distanza % dal VWAP di giornata e RSI(14) su barre a 5 min. Entra se `|distanza| ≥ 1,2%` e RSI conferma esaurimento (>70 sopra il VWAP → SHORT, <30 sotto → LONG); i più estesi riempiono gli slot liberi (max 8). Esce su rientro al VWAP, stop −0,6%, o 45 min in posizione.
- **ORB (LAB A)**, `server/orb.ts`: range di apertura (alto/basso dei primi 15 min, calcolato una volta al giorno e messo in cache in `lab_state`), filtro ATR(14)% da barre giornaliere, conferma volume (barra di rottura ≥ 1,8× il volume medio delle barre della sessione finora). Entra sulla rottura del range; stop/target a 0,5×/2,0× l'ampiezza del range (persistiti in `lab_state`, non c'è colonna dedicata su `lab_positions`).
- **Pairs trading (LAB B)**, `server/pairsTrading.ts`: coppie selezionate una volta al giorno per correlazione dei rendimenti giornalieri **entro lo stesso settore** (proxy dichiarato della cointegrazione vera — vedi limite noto sotto), le 10 più correlate. Entra quando `|z-score del rapporto di prezzo| ≥ 2,0` (vende il titolo relativamente caro, compra quello debole, capitale diviso a metà); esce a `|z| ≤ 0,3` o stop a `|z| ≥ 3,5`. Le due gambe condividono `pair_key` in `lab_positions` per chiudersi insieme.
- **Sizing comune**: `CAPITAL / MAX_POSITIONS` della singola strategia, non `CAPITAL / dimensione universo` — così ogni lab dispiega tutto il capitale quando è a pieno regime. Equal-weight qui è per confrontabilità tra i 3 lab (stesso capitale, unica variabile è la strategia), non gestione del rischio — sul conto reale il sizing sarà libero, obiettivo massimizzare il realized (vedi "Prossimi passi").
- **Limiti noti**: RSI(14) su barre a 5 min richiede ~70 minuti di storico (i simboli senza abbastanza barre vengono scartati, non è un bug); il pairs trading usa correlazione come proxy della cointegrazione, non un vero test ADF/Engle-Granger.

### Bug trovato e corretto prima del primo giorno live: contaminazione pre-market

Il fetch delle barre "di oggi" partiva da mezzanotte UTC, includendo le barre pre-market IEX (dalle 4:00 ET) insieme a quelle della sessione regolare (9:30-16:00 ET). Risultato: il range di apertura ORB veniva calcolato su rumore pre-market invece che sui primi 15 minuti veri, il pairs trading entrava su prezzi pre-market, il VWAP di giornata era falsato. Scoperto rigiocando dati reali storici (vedi sotto) — con la contaminazione, ORB apriva 21 posizioni in un giorno con stop/target larghi pochi centesimi; dopo il fix, 6 posizioni con distanze sensate. Fix: `server/marketHours.ts` (`fetchMarketSession`) legge il calendario reale di Alpaca (open/close in orario locale di New York) e lo converte in UTC preciso via `Intl` — niente più ipotesi fisse su un singolo orario UTC, corretto sia in EDT sia in EST.

**Come validare prima di ogni mercato aperto**: ricreare un endpoint tipo `api/cron/backtest.ts` (rimosso dopo l'uso per restare sotto il limite di 12 funzioni — la logica era: rigiocare un giorno storico reale attraverso le stesse funzioni pure di `server/*.ts`, tutto in memoria, senza toccare `lab_positions`/`lab_state` di produzione) è il modo più veloce per scoprire bug come questo senza aspettare un giorno di mercato vero. Vale la pena rifarlo prima di modifiche importanti alla logica di strategia.

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
- `src/lib/labPositions.ts` + `src/hooks` (via `AppState`) — fetch di `/api/lab/positions`, pollato ogni 20s insieme alle quotazioni; combinato con `mergeRealLabData` in `mockData.ts`.
- `src/context/AppState.tsx` — polla quotazioni e posizioni lab in parallelo, espone `liveMarket` (già combinato: simulazione + reale dove disponibile) a tutte le viste.
- `api/broker/*.ts` — funzioni serverless Vercel che parlano con la Trading API di Alpaca usando le chiavi lato server (`server/alpaca.ts`).
- `api/market/quotes.ts` — legge gli snapshot reali dalla Market Data API di Alpaca (`server/alpaca.ts` → `alpacaDataFetch`, host `data.alpaca.markets`, separato dalla Trading API).
- `api/lab/positions.ts` — espone posizioni aperte + realized di oggi per strategia da `lab_positions`, al frontend.
- `api/cron/eod-close.ts` — chiusura EOD reale (conto Alpaca), schedulata via Vercel Cron in `vercel.json`. Protetta da `CRON_SECRET` (Vercel la invia da sola come header `Authorization: Bearer` quando la variabile è impostata).
- `api/cron/tick.ts` — tick periodico, invocato da GitHub Actions. Orchestra tutte e tre le strategie: fetch prezzi/barre Alpaca (via `server/marketHours.ts` per i confini esatti della sessione), stato posizioni da DB, chiama `server/{vwapReversion,orb,pairsTrading}.ts` + la rete di sicurezza EOD (`server/labEod.ts`), applica gli update. Protetto da `TICK_SECRET` (va impostato a mano sia su Vercel sia come secret del repo GitHub — nessun auto-injection qui, a differenza di `CRON_SECRET`).
- `server/{vwapReversion,orb,pairsTrading}.ts` — logica pura (nessun I/O) di ciascuna strategia: `decideEntries`/`decideExits` + gli indicatori (RSI, ATR, range di apertura, correlazione/z-score). Testate a mano con casi noti prima del deploy, e con un backtest su dati storici reali (vedi sopra) prima del primo giorno live.
- `server/labEod.ts` — chiusura EOD generica per qualunque posizione lab ancora aperta e in utile, indipendente dalla strategia.
- `server/marketHours.ts` — orario preciso di apertura/chiusura regolare per una data, dal calendario reale di Alpaca (mai un'ipotesi fissa su un'ora UTC — vedi il bug corretto sopra).
- `server/db.ts` — client Neon condiviso (`db()`), lazy-init su `POSTGRES_URL`.
- `db/schema.sql` + `scripts/migrate.mjs` — schema e migrazione (locale, non automatica al deploy). `lab_positions` ha `pair_key` per collegare le due gambe di una coppia.
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

1. **Verificare le tre strategie al prossimo giorno di borsa reale** — validate via backtest su due giorni storici (2026-09-10, 2026-09-11), mai viste girare su un tick dal vivo. Controllare `tick_log` e `lab_positions` durante la mattina, non fidarsi solo del backtest.
2. Una volta validate dal vivo: progettare il sizing "libero" per il conto reale (diverso dall'equal-weight dei lab, vedi nota sopra) e collegare "Conferma e attiva" a `submitOrder` per davvero, con conferma asincrona e stato di errore (oggi non progettato).
3. Debriefing serale automatico e `Storico` reale (popolare `sessions` da `lab_positions` invece dei mock in `mockData.ts`).
4. Lot-matching per il realized P&L preciso (vedi limite noto sopra).
5. `streamQuotes` via WebSocket Alpaca — richiede un servizio a lunga esecuzione separato, non funzioni serverless Vercel (il polling REST attuale ogni 20s è il sostituto pragmatico).
6. Stati ancora da progettare: loading, disconnessione API, mercato chiuso, stop di portafoglio scattato, conferma mancante a mercato aperto. Chiedere prima di inventarli.

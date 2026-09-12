# WHAD Trading — istruzioni di progetto

Piattaforma **WHAD Trading**: tre strategie eseguite in parallelo su tre portafogli "laboratorio" identici, più un conto reale che ogni mattina, dopo un debriefing, adotta la strategia migliore per la giornata.

## Stato attuale

Frontend React + Vite + TypeScript con le 6 viste ricostruite fedelmente dal design handoff, dati **finti e deterministici** (stessa logica del prototipo `.dc.html`).

Adapter broker Alpaca (Trading API, non Broker API — vedi sotto) collegato in sola lettura per il **conto reale**: stato connessione, posizioni, market clock. Le funzioni serverless in `api/broker/` tengono le chiavi lato server; il frontend non le vede mai. Le 3 card "Portafoglio laboratorio" restano dati finti.

## Riferimenti di design

Il design handoff originale vive in `../Interfaccia trading multi-strategia/design_handoff_whad_trading/` (fuori da questo repo):
- `README.md` — specifica di design completa (viste, token, misure, interazioni). Fonte di verità per la UI.
- `screenshots/` — aspetto atteso di ogni vista.
- `WHAD Trading.dc.html` — prototipo HTML navigabile con la logica dei dati finti.
- `API.md` — modello dati e contratto dell'adapter broker.

## Struttura del codice

- `src/types.ts` — interfacce del modello dati e contratto `BrokerAdapter` (da `API.md`).
- `src/data/mockData.ts` — dati finti deterministici (stessa logica hash del prototipo) + helper di formattazione (`money`, `dec`, `pnlColor`, `formatPnl`).
- `src/context/AppState.tsx` — stato condiviso: toggle Valore/%, conferma debriefing, countdown.
- `src/components/` — Sidebar, Header, TickerTape, Sparkline, PnlHistogram, PnlModeToggle.
- `src/views/` — una vista per file: `LabView`, `StrategyView`, `DebriefView`, `LiveView`, `HistoryView`, `RulesView`.
- `src/lib/brokerAdapters/alpaca.ts` — implementazione client di `BrokerAdapter`, chiama solo `/api/broker/*` (mai Alpaca direttamente dal browser).
- `src/hooks/useAlpacaStatus.ts` — legge lo stato reale del broker con fallback silenzioso ai dati finti se le chiavi non sono configurate.
- `api/broker/*.ts` — funzioni serverless Vercel che parlano con la Trading API di Alpaca usando le chiavi lato server (`api/lib/alpaca.ts`).
- Routing reale con `react-router-dom`: `/lab`, `/strategie/:id`, `/debriefing`, `/reale`, `/storico`, `/regole`.

### Adapter broker: cosa fa e cosa no

- **Alpaca Trading API**, non Broker API: un solo conto (il "conto reale"), niente onboarding di conti terzi. I 3 portafogli laboratorio restano simulati internamente — Alpaca non è pensato per più conti paralleli sotto le stesse chiavi.
- Implementato (sola lettura + scrittura non ancora collegata alla UI): `status`, `getPositions`, `marketClock`, `getExecutions`, `getRealizedPnl`, `submitOrder`, `closePosition`.
- **Limite noto**: `getRealizedPnl` usa la portfolio history di Alpaca (variazione di equity = realized + unrealized), non il solo realized "incassato" richiesto dalla spec — Alpaca non espone il realized per singolo fill via REST senza lot-matching. Da rifinire quando servirà precisione contabile.
- **Non implementato**: `streamQuotes` (richiede una connessione persistente, incompatibile con le funzioni serverless Vercel — serve un servizio a lunga esecuzione separato, vedi sotto).
- Variabili d'ambiente richieste (solo server-side, mai `VITE_*`): `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY`, `ALPACA_ENV` (`paper`/`live`). Vedi `.env.example`.

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

1. Sostituire il resto di `src/data/mockData.ts` (posizioni, ticker) con chiamate reali man mano che serve, mantenendo intatte le interfacce in `src/types.ts`.
2. Lot-matching per il realized P&L preciso (vedi limite noto sopra).
3. Servizio a lunga esecuzione separato (non Vercel serverless) per: `streamQuotes` via WebSocket Alpaca, e i job schedulati (pre-apertura, chiusura EOD, debriefing serale).
4. Stati ancora da progettare: loading, disconnessione API, mercato chiuso, stop di portafoglio scattato, conferma mancante a mercato aperto. Chiedere prima di inventarli.

# WHAD · Trading

Interfaccia di una piattaforma di trading algoritmico con tre strategie in parallelo su portafogli "laboratorio" identici, più un conto reale che ogni mattina adotta la strategia migliore dopo un debriefing.

Ricostruzione fedele del design handoff Claude Design (vedi [CLAUDE.md](./CLAUDE.md) per i dettagli e i riferimenti). Dati attualmente **finti e deterministici** — nessun backend/broker reale collegato.

## Sviluppo

```bash
npm install
npm run dev
```

Apre l'app su `http://localhost:5173` (frontend con dati finti — le funzioni `/api/broker/*` non girano con `vite` da solo).

Per testare in locale anche l'integrazione Alpaca serve `vercel dev` al posto di `vite`:

```bash
vercel env pull .env.local   # scarica le variabili impostate su Vercel
npm run dev:full             # vercel dev, serve sia il frontend che /api
```

## Script disponibili

- `npm run dev` — server di sviluppo Vite con hot reload (solo frontend, dati finti).
- `npm run dev:full` — `vercel dev`, frontend + funzioni serverless `/api/broker/*`.
- `npm run build` — build di produzione in `dist/`.
- `npm run typecheck` — controllo TypeScript senza emettere output.
- `npm run preview` — serve la build di produzione localmente.

## Variabili d'ambiente

Vedi [`.env.example`](./.env.example). Le chiavi Alpaca vanno impostate su Vercel (Project Settings → Environment Variables), mai committate.

## Deploy

Pensato per Vercel come sito statico (Vite SPA). Comando di build: `npm run build`, directory di output: `dist`.

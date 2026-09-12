# WHAD · Trading

Interfaccia di una piattaforma di trading algoritmico con tre strategie in parallelo su portafogli "laboratorio" identici, più un conto reale che ogni mattina adotta la strategia migliore dopo un debriefing.

Ricostruzione fedele del design handoff Claude Design (vedi [CLAUDE.md](./CLAUDE.md) per i dettagli e i riferimenti). Prezzi di mercato e conto reale collegati ad Alpaca; i 3 laboratori restano simulati (nessuna logica di strategia vera ancora).

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
- `npm run db:migrate` — applica `db/schema.sql` al database (richiede `.env.local` da `vercel env pull`).

## Variabili d'ambiente

Vedi [`.env.example`](./.env.example). Le chiavi Alpaca e i segreti cron vanno impostati su Vercel (Project Settings → Environment Variables), mai committati. `POSTGRES_URL` è impostata automaticamente da Vercel quando si collega il database. `TICK_SECRET` va anche impostato come secret del repository GitHub (stesso valore), perché lo scheduler è `.github/workflows/tick.yml`, non Vercel Cron.

## Deploy

Pensato per Vercel come sito statico (Vite SPA). Comando di build: `npm run build`, directory di output: `dist`.

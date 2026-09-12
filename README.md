# WHAD · Trading

Interfaccia di una piattaforma di trading algoritmico con tre strategie in parallelo su portafogli "laboratorio" identici, più un conto reale che ogni mattina adotta la strategia migliore dopo un debriefing.

Ricostruzione fedele del design handoff Claude Design (vedi [CLAUDE.md](./CLAUDE.md) per i dettagli e i riferimenti). Dati attualmente **finti e deterministici** — nessun backend/broker reale collegato.

## Sviluppo

```bash
npm install
npm run dev
```

Apre l'app su `http://localhost:5173`.

## Script disponibili

- `npm run dev` — server di sviluppo Vite con hot reload.
- `npm run build` — build di produzione in `dist/`.
- `npm run typecheck` — controllo TypeScript senza emettere output.
- `npm run preview` — serve la build di produzione localmente.

## Deploy

Pensato per Vercel come sito statico (Vite SPA). Comando di build: `npm run build`, directory di output: `dist`.

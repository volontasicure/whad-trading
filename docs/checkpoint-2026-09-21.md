# Checkpoint 21/9/2026 (5ª seduta)

Sola lettura: nessuna modifica a codice, DB o ordini. Campione: 5 sedute, indicativo.

## Verifica EOD
- Funziona dal vivo: 5 posizioni reali in utile chiuse con `exit_reason='eod'` (XOM +64, HON +49, CVX +136, AMZN +77, CRM +6 = +332), bracket annullati, righe scritte in `real_positions`.
- Nessun errore in `tick_log`, nessun ordine aperto su Alpaca, DB e broker allineati.
- Aperta per regola (in perdita): NKE SHORT 892 @35,95, ora 36,08 (−116). Un gap sopra 36,4 vale circa −400$.

## P&L 21/9
| | P&L |
|---|---|
| ORB (lab) | +495 (7 chiusure, 6 vincenti) |
| Pairs (lab) | +2 |
| VWAP reversion (lab) | −448 (16 chiusure, 7 vincenti; META short stoppata 4 volte) |
| Conto reale | realized +474, NKE −116 aperta, equity −337 |

## Riconciliazione equity
- DB: +358 (realized +474, NKE −116). Equity Alpaca: −337. Gap circa −695.
- Causa: il DB misura dall'ingresso, Alpaca dalla chiusura di venerdì. Le 4 posizioni ereditate avevano guadagnato circa +870 già dentro `last_equity`. Con la base Alpaca la stima è circa −515.
- Residuo circa +180 non spiegato (ipotesi: chiusura daily bar vs prezzo ufficiale 16:00, costi, slippage). Nessun fill controllato.
- Il netto per trade del debriefing è affidabile per il ranking, ma non è la variazione di equity del giorno.

## Perdenti tenuti overnight
- Lab: 6 posizioni tenute perché in perdita, chiuse il giorno dopo per −565$ totali (CAT −315, GS −124, TMO −122, ORCL −19, JPM −13, GS +28). KO/PEP ancora aperte.
- Reale: campione confuso dal bug EOD del 18/9, che non chiudeva nemmeno i profittevoli.
- Chiuse in utile per EOD lo stesso giorno: 37 nei lab (+2.761), 5 nel reale (+332).
- Evidenza sufficiente solo a dire che la coda dei perdenti costa. Non abbastanza per cambiare la regola.

## Evidenze per il checkpoint (backtest 18/9, recente / fuori campione)
- Pairs: unica regola sempre positiva ("sempre pairs" +683 / +1.498).
- ORB: +495 oggi, in linea con i backtest. Stop più larghi peggiorano su entrambe le finestre.
- VWAP: la più debole (oggi −448, stesso schema di BA il 16/9). Filtro di trend già in produzione ma spento: migliora la finestra recente, peggiora quella fuori campione. Riaprire solo con più dati reali.
- Nessuna regola di scelta giornaliera è robusta su entrambe le finestre. "Vincitore di ieri" è la peggiore.

## Azioni suggerite
1. Nessuna modifica alla logica di trading fino a più dati.
2. Martedì mattina controllare NKE all'apertura (bracket annullato, protetta solo dal controllo del tick).
3. Leggere il P&L delle strategie dal netto per trade, non dalla variazione di equity giornaliera.
4. Residuo di circa 180$: indagare solo se serve, leggendo i fill di Alpaca sulle posizioni ereditate.

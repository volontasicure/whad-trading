// GENERATO da scripts/gen-backtest-card.mjs — non modificare a mano.
// Backtest storico reale (configurazione di produzione, costi di esecuzione dedotti), snapshot
// del 2026-10-11: non si aggiorna da solo, va rigenerato dopo ogni modifica di strategia.
// "costs" è il costo medio PER SEDUTA, "tradesPerSession" i round trip chiusi per seduta
// (pairs: coppie complete, non gambe), "dailyPnl" il netto delle ultime 20 sedute.

export const BACKTEST_META = {
  "sessions": 99,
  "firstDay": "2026-05-20",
  "lastDay": "2026-10-09",
  "costPctPerSide": 0.00023,
  "generatedAt": "2026-10-11"
};

export const BACKTEST_RESULTS = {
  "orb": {
    "net": -8850,
    "sharpe": -3.62,
    "winRate": 0.399,
    "tradesPerSession": 9.7,
    "trades": 959,
    "costs": 74,
    "profitFactor": 0.81,
    "dailyPnl": [
      -141,
      259,
      -79,
      -299,
      62,
      182,
      -9,
      -446,
      -900,
      -365,
      -120,
      -578,
      219,
      -81,
      -529,
      -158,
      -50,
      -195,
      443,
      66
    ]
  },
  "pairs": {
    "net": 4137,
    "sharpe": 6,
    "winRate": 1,
    "tradesPerSession": 0.2,
    "trades": 18,
    "costs": 1,
    "profitFactor": null,
    "dailyPnl": [
      0,
      0,
      0,
      0,
      0,
      0,
      171,
      0,
      0,
      0,
      0,
      54,
      80,
      0,
      0,
      0,
      0,
      0,
      0,
      0
    ]
  },
  "vwap_reversion": {
    "net": 440,
    "sharpe": 0.51,
    "winRate": 0.454,
    "tradesPerSession": 1.2,
    "trades": 119,
    "costs": 7,
    "profitFactor": 1.07,
    "dailyPnl": [
      -59,
      83,
      120,
      0,
      0,
      -422,
      0,
      0,
      0,
      0,
      0,
      305,
      0,
      75,
      0,
      0,
      0,
      0,
      -93,
      0
    ]
  }
};

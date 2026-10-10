// GENERATO da scripts/gen-backtest-card.mjs — non modificare a mano.
// Backtest storico reale (configurazione di produzione, costi di esecuzione dedotti), snapshot
// del 2026-10-10: non si aggiorna da solo, va rigenerato dopo ogni modifica di strategia.
// "costs" è il costo medio PER SEDUTA, "tradesPerSession" i round trip chiusi per seduta
// (pairs: coppie complete, non gambe), "dailyPnl" il netto delle ultime 20 sedute.

export const BACKTEST_META = {
  "sessions": 101,
  "firstDay": "2026-05-18",
  "lastDay": "2026-10-09",
  "costPctPerSide": 0.00023,
  "generatedAt": "2026-10-10"
};

export const BACKTEST_RESULTS = {
  "orb": {
    "net": -8850,
    "sharpe": -3.58,
    "winRate": 0.398,
    "tradesPerSession": 9.7,
    "costs": 73,
    "profitFactor": 0.82,
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
    "net": 2227,
    "sharpe": 1.97,
    "winRate": 0.559,
    "tradesPerSession": 0.3,
    "costs": 2,
    "profitFactor": 1.76,
    "dailyPnl": [
      0,
      -216,
      0,
      0,
      0,
      0,
      384,
      0,
      0,
      0,
      0,
      323,
      177,
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
    "net": 492,
    "sharpe": 0.56,
    "winRate": 0.458,
    "tradesPerSession": 1.2,
    "costs": 7,
    "profitFactor": 1.08,
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

// Test di cointegrazione Engle-Granger (OLS sui prezzi log + ADF sui residui), per sostituire
// in parte la correlazione dei rendimenti come proxy di selezione delle coppie in
// server/pairsTrading.ts — vedi "Due coppie pairs strutturalmente non mean-reverting" in
// CLAUDE.md (1/10/2026): JPM/BAC e KO/PEP sono correlate ma non tornano mai al rapporto di
// partenza, un caso da manuale di correlazione alta senza cointegrazione vera.
//
// Implementazione minima e deterministica, nessuna libreria di statistica esterna:
// - passo 1 (Engle-Granger): regressione OLS bivariata logA = alpha + beta*logB + residuo,
//   direzione fissa (sempre A su B, non il minimo tra le due direzioni) per restare
//   deterministico — semplificazione dichiarata, come la correlazione-come-proxy in
//   pairsTrading.ts.
// - passo 2 (ADF): test Augmented Dickey-Fuller con un numero fisso di ritardi (nessuna
//   selezione automatica via AIC/BIC) sui residui del passo 1.
// - valori critici di MacKinnon (1996/2010) per il test di Engle-Granger a 2 variabili, senza
//   trend — valori asintotici standard di letteratura, non corretti per il campione finito
//   esatto di ogni coppia.

export const EG_CRITICAL_VALUES = { "1%": -3.9, "5%": -3.34, "10%": -3.04 } as const;

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Regressione OLS bivariata con intercetta: y = alpha + beta*x + residuo (forma chiusa). */
function olsBivariate(y: number[], x: number[]): { alpha: number; beta: number; residuals: number[] } {
  const mx = mean(x);
  const my = mean(y);
  let cov = 0;
  let varX = 0;
  for (let i = 0; i < x.length; i++) {
    cov += (x[i] - mx) * (y[i] - my);
    varX += (x[i] - mx) ** 2;
  }
  const beta = varX === 0 ? 0 : cov / varX;
  const alpha = my - beta * mx;
  const residuals = y.map((yi, i) => yi - alpha - beta * x[i]);
  return { alpha, beta, residuals };
}

/** Inversione di una matrice quadrata via Gauss-Jordan con pivoting parziale. null se singolare. */
function invertMatrix(A: number[][]): number[][] | null {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[maxRow][col])) maxRow = r;
    [M[col], M[maxRow]] = [M[maxRow], M[col]];
    const pivot = M[col][col];
    if (Math.abs(pivot) < 1e-10) return null;
    for (let c = 0; c < 2 * n; c++) M[col][c] /= pivot;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      for (let c = 0; c < 2 * n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row) => row.slice(n));
}

/** OLS multiplo via equazioni normali; ritorna anche l'errore standard di ogni coefficiente. */
function olsMultiple(X: number[][], y: number[]): { coeffs: number[]; seCoeffs: number[] } | null {
  const m = X.length;
  const k = X[0].length;
  if (m <= k) return null;
  const XtX: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty: number[] = new Array(k).fill(0);
  for (let i = 0; i < m; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  const XtXInv = invertMatrix(XtX);
  if (!XtXInv) return null;
  const coeffs = XtXInv.map((row) => row.reduce((s, v, j) => s + v * Xty[j], 0));
  const residuals = y.map((yi, i) => yi - X[i].reduce((s, v, j) => s + v * coeffs[j], 0));
  const ssr = residuals.reduce((s, e) => s + e * e, 0);
  const dof = m - k;
  const sigma2 = dof > 0 ? ssr / dof : NaN;
  const seCoeffs = XtXInv.map((row, j) => Math.sqrt(sigma2 * row[j]));
  return { coeffs, seCoeffs };
}

/**
 * Test ADF con `lags` ritardi fissi sulla serie: regressione
 * Δserie_t = c + rho*serie_{t-1} + somma(phi_i * Δserie_{t-i}) + errore.
 * Ritorna la t-statistic su rho — più negativa = più evidenza contro la radice unitaria
 * (serie stazionaria). null se non ci sono abbastanza osservazioni per una stima affidabile.
 */
export function adfTStat(series: number[], lags = 1): number | null {
  const n = series.length;
  if (n < lags + 12) return null;

  const diffs: number[] = [];
  for (let i = 1; i < n; i++) diffs.push(series[i] - series[i - 1]); // diffs[i-1] = Δserie_i

  const rows: number[][] = [];
  const yVals: number[] = [];
  for (let t = lags + 1; t < n; t++) {
    const row = [1, series[t - 1]];
    for (let l = 1; l <= lags; l++) row.push(diffs[t - 1 - l]); // Δserie_{t-l}
    rows.push(row);
    yVals.push(diffs[t - 1]); // Δserie_t
  }

  const fit = olsMultiple(rows, yVals);
  if (!fit) return null;
  const rhoIndex = 1; // posizione di serie_{t-1} tra i regressori [1, serie_{t-1}, ...ritardi]
  const se = fit.seCoeffs[rhoIndex];
  if (!se || !Number.isFinite(se) || se === 0) return null;
  return fit.coeffs[rhoIndex] / se;
}

/**
 * t-statistic del test di Engle-Granger per la coppia (A, B): OLS di logA su logB sulle
 * ultime `window` chiusure, poi ADF sui residui. null se non c'è abbastanza storico per la
 * finestra richiesta. Finestra più corta del lookback di correlazione/z-score (di default
 * l'intero storico disponibile) perché una rottura di cointegrazione recente, come vista
 * nella scoperta dell'1/10/2026, resterebbe diluita e invisibile in un test su 1-2 anni.
 */
export function cointegrationTStat(
  closesAAscending: number[],
  closesBAscending: number[],
  window: number,
  lags = 1
): number | null {
  const n = Math.min(closesAAscending.length, closesBAscending.length);
  if (n < window) return null;
  const a = closesAAscending.slice(-window).map((c) => Math.log(c));
  const b = closesBAscending.slice(-window).map((c) => Math.log(c));
  const { residuals } = olsBivariate(a, b);
  return adfTStat(residuals, lags);
}

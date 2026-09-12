import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * `api/*.ts` sono funzioni serverless Vercel, servite solo da `vercel dev` o in produzione.
 * Sotto `vite dev` puro quei file esistono comunque sul filesystem del progetto, quindi Vite
 * prova a trasformarli come moduli quando il browser li richiama via fetch — con query string
 * come `?since=...000Z` esplode con un errore esbuild invece di un 404 pulito. Questo plugin
 * intercetta le richieste a /api prima che ci arrivi il middleware di trasformazione di Vite,
 * cosicché l'app faccia il fallback silenzioso ai dati finti come previsto.
 */
function blockApiInDevPlugin(): Plugin {
  return {
    name: "block-api-in-dev",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith("/api/")) {
          res.statusCode = 404;
          res.end("Not found — /api gira solo con `vercel dev` o in produzione, non con `vite`.");
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), blockApiInDevPlugin()],
});

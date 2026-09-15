import { Link, useLocation } from "react-router-dom";
import { useAppState } from "../context/AppState";

/**
 * Avviso persistente su tutte le pagine quando il mercato è aperto e il debriefing di oggi
 * non è ancora stato confermato. isOpen === true richiesto esplicitamente (non truthy): finché
 * l'orologio di mercato non ha risposto almeno una volta, niente falsi allarmi.
 */
export function ConfirmBanner() {
  const { confirmed, autoConfirm, marketClock } = useAppState();
  const location = useLocation();

  if (autoConfirm || confirmed) return null;
  if (marketClock.isOpen !== true) return null;
  if (location.pathname === "/debriefing") return null;

  return (
    <div
      style={{
        padding: "9px 16px",
        background: "var(--amber-tint)",
        color: "var(--amber-ink)",
        borderBottom: "1px solid var(--border-main)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        flexWrap: "wrap",
        textAlign: "center",
      }}
    >
      <span style={{ fontSize: 12.5 }}>Il mercato è aperto e il debriefing di oggi non è ancora stato confermato.</span>
      <Link to="/debriefing" className="mono" style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.05em", color: "inherit" }}>
        VAI AL DEBRIEFING →
      </Link>
    </div>
  );
}

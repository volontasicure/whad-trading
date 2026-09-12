import { useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Sidebar } from "./components/Sidebar";
import { AppStateProvider } from "./context/AppState";
import { LabView } from "./views/LabView";
import { StrategyView } from "./views/StrategyView";
import { DebriefView } from "./views/DebriefView";
import { LiveView } from "./views/LiveView";
import { HistoryView } from "./views/HistoryView";
import { RulesView } from "./views/RulesView";

export default function App() {
  const [navOpen, setNavOpen] = useState(false);

  return (
    <AppStateProvider>
      <div className="app-shell">
        <div className="mobile-topbar">
          <button className="mobile-nav-toggle" onClick={() => setNavOpen(true)} aria-label="Apri il menu">
            ☰
          </button>
          <div className="mono" style={{ fontSize: 13, fontWeight: 600, letterSpacing: "0.14em" }}>
            WHAD<span style={{ color: "var(--accent)" }}>·</span>TRADING
          </div>
        </div>
        <div className={`mobile-nav-overlay${navOpen ? " open" : ""}`} onClick={() => setNavOpen(false)} />
        <Sidebar mobileOpen={navOpen} onNavigate={() => setNavOpen(false)} />
        <div style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column" }}>
          <Routes>
            <Route path="/" element={<Navigate to="/lab" replace />} />
            <Route path="/lab" element={<LabView />} />
            <Route path="/strategie" element={<StrategyView />} />
            <Route path="/strategie/:id" element={<StrategyView />} />
            <Route path="/debriefing" element={<DebriefView />} />
            <Route path="/reale" element={<LiveView />} />
            <Route path="/storico" element={<HistoryView />} />
            <Route path="/regole" element={<RulesView />} />
            <Route path="*" element={<Navigate to="/lab" replace />} />
          </Routes>
        </div>
      </div>
    </AppStateProvider>
  );
}

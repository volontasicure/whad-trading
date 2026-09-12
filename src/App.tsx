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
  return (
    <AppStateProvider>
      <div style={{ display: "flex", alignItems: "stretch", minHeight: "100vh", background: "var(--bg-page)", color: "var(--text-primary)", fontSize: 14 }}>
        <Sidebar />
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

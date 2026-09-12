import { useAppState } from "../context/AppState";
import type { PnlMode } from "../data/mockData";

const OPTIONS: { id: PnlMode; label: string }[] = [
  { id: "abs", label: "Valore" },
  { id: "pct", label: "% su capitale" },
];

export function PnlModeToggle() {
  const { pnlMode, setPnlMode } = useAppState();
  return (
    <div style={{ display: "flex", gap: 6, flex: "0 0 auto" }}>
      {OPTIONS.map((o) => (
        <div
          key={o.id}
          className={`pill${pnlMode === o.id ? " active" : ""}`}
          onClick={() => setPnlMode(o.id)}
        >
          {o.label}
        </div>
      ))}
    </div>
  );
}

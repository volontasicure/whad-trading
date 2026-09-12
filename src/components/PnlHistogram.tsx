interface PnlHistogramProps {
  values: number[];
}

/** Istogramma di P&L per seduta: barra verde sopra la linea dello zero, rossa sotto. */
export function PnlHistogram({ values }: PnlHistogramProps) {
  const barMax = Math.max(...values.map((v) => Math.abs(v)), 1);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "stretch", gap: 4, height: 92 }}>
        {values.map((v, i) => (
          <div key={i} style={{ flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "center" }}>
            <div style={{ height: 46, display: "flex", alignItems: "flex-end" }}>
              <div
                style={{
                  width: "100%",
                  height: v > 0 ? (v / barMax) * 44 : 0,
                  borderRadius: "2px 2px 0 0",
                  background: "#4ade80",
                }}
              />
            </div>
            <div style={{ height: 1, background: "#e6e5e0" }} />
            <div style={{ height: 46 }}>
              <div
                style={{
                  width: "100%",
                  height: v < 0 ? (-v / barMax) * 44 : 0,
                  borderRadius: "0 0 2px 2px",
                  background: "#f0a9a2",
                }}
              />
            </div>
          </div>
        ))}
      </div>
      <div
        className="mono"
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 10, color: "#8d8a82" }}
      >
        <div>&minus;20</div>
        <div>oggi</div>
      </div>
    </div>
  );
}

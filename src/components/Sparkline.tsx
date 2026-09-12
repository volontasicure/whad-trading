interface SparklineProps {
  values: number[];
  color: string;
  height?: number;
}

export function Sparkline({ values, color, height = 46 }: SparklineProps) {
  const w = 260;
  const h = height;
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - 3 - ((v - min) / span) * (h - 8);
    return [x, y];
  });
  const zeroY = h - 3 - ((0 - min) / span) * (h - 8);
  const last = pts[pts.length - 1];

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height: `${h}px`, display: "block", overflow: "visible" }}
    >
      <line x1={0} x2={w} y1={zeroY} y2={zeroY} stroke="#e6e5e0" strokeWidth={1} strokeDasharray="3 3" />
      <polyline
        points={pts.map((p) => p.join(",")).join(" ")}
        fill="none"
        stroke={color}
        strokeWidth={1.8}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={last[0]} cy={last[1]} r={2.6} fill={color} />
    </svg>
  );
}

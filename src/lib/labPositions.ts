import type { RealLabOverrides } from "../data/mockData";

/** Legge le posizioni reali dei laboratori dal backend; lancia se non disponibili. */
export async function fetchLabPositions(): Promise<RealLabOverrides> {
  const res = await fetch("/api/lab/positions");
  if (!res.ok) {
    throw new Error(`lab positions -> ${res.status}`);
  }
  return (await res.json()) as RealLabOverrides;
}

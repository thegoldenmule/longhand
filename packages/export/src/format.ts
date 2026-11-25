/** Small locale-free formatting helpers shared by the renderers. */

/** `1234567` → `"1,234,567"` (no `Intl`, so output is the same everywhere). */
export function groupThousands(n: number): string {
  const s = String(Math.trunc(Math.abs(n)));
  const grouped = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return n < 0 ? `-${grouped}` : grouped;
}

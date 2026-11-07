/** 41.234 -> "0:41.23" */
export function formatTime(t: number | null | undefined): string {
  if (t === null || t === undefined || !Number.isFinite(t)) return '--:--.--';
  const neg = t < 0;
  const cs = Math.floor(Math.abs(t) * 100 + 1e-6);
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${neg ? '-' : ''}${m}:${s.toString().padStart(2, '0')}.${c.toString().padStart(2, '0')}`;
}

/** -0.456 -> "−0.46", 1.2 -> "+1.20" (uses a real minus sign). */
export function formatDelta(d: number | null | undefined): string {
  if (d === null || d === undefined || !Number.isFinite(d)) return '';
  const v = Math.round(Math.abs(d) * 100) / 100;
  const sign = v === 0 ? '±' : d < 0 ? '−' : '+';
  return `${sign}${v.toFixed(2)}`;
}

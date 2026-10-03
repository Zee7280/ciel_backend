/** "HH:mm" (or "H:mm") → minutes since midnight, or null when not a valid clock time. */
export function clockToMinutes(value: unknown): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(value ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** True when two same-day sessions share any time (touching end-to-start is NOT an overlap). */
export function sessionsOverlap(
  aStart: unknown,
  aEnd: unknown,
  bStart: unknown,
  bEnd: unknown,
): boolean {
  const as = clockToMinutes(aStart);
  const ae = clockToMinutes(aEnd);
  const bs = clockToMinutes(bStart);
  const be = clockToMinutes(bEnd);
  if (as == null || ae == null || bs == null || be == null) return false;
  return as < be && bs < ae;
}

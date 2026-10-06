/** Display CII for every role: published score when locked, otherwise the latest available number. */

function finiteCii(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function isCiiLocked(lock: { locked?: unknown } | null | undefined): boolean {
  return lock?.locked === true || lock?.locked === 'true';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function pickCiiV45DisplayScore(
  ciiV45: unknown,
  lock?: { locked?: unknown; adminApprovedScore?: unknown } | null,
): number | null {
  const cii = asRecord(ciiV45);
  if (!cii) return null;
  if (isCiiLocked(lock)) {
    return (
      finiteCii(lock?.adminApprovedScore) ??
      finiteCii(cii.finalCII) ??
      finiteCii(cii.diagnosticCII)
    );
  }
  return (
    finiteCii(cii.diagnosticCII) ??
    finiteCii(cii.baseCII) ??
    finiteCii(cii.finalCII) ??
    finiteCii(cii.knownBasePoints) ??
    finiteCii(cii.aiReportScore)
  );
}

export function pickCiiV45DisplayBadge(
  ciiV45: unknown,
  lock?: { locked?: unknown } | null,
): { name: string | null; level: number | null } | null {
  const cii = asRecord(ciiV45);
  if (!cii) return null;
  const read = (raw: unknown) => {
    const b = asRecord(raw);
    if (!b) return null;
    const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : null;
    const level = finiteCii(b.level);
    if (!name && level == null) return null;
    return { name, level };
  };
  if (isCiiLocked(lock)) {
    return (
      read(cii.finalBadge) ??
      read(cii.recommendedBadge) ??
      read(cii.diagnosticBadge)
    );
  }
  return (
    read(cii.recommendedBadge) ??
    read(cii.diagnosticBadge) ??
    read(cii.finalBadge)
  );
}

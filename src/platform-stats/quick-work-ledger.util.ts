import { normalizeCityKey, PAKISTAN_CITY_GEO } from './pakistan-geo';

/** Path label shown on the public SDG wheel for approved Quick Community Work logs. */
export const QUICK_WORK_LEDGER_PATH = 'Quick Community Work';

/** A pin further than this from every listed city is not attributed to any of them. */
const PIN_CITY_MAX_KM = 60;

export type QuickWorkLedgerLog = {
  id: string;
  title: string;
  leadUserId: string;
  location: string;
  locationPin: string | null;
  host: string | null;
  partners: string[] | null;
  sdg: number | null;
  peopleReached: number | null;
  reviewedAt: Date | null;
  updatedAt: Date;
  participants: { userId: string; minutes: number }[];
};

/** One approved quick-work log, reduced to what the public community ledger adds up. */
export type QuickWorkLedgerEntry = {
  logId: string;
  title: string;
  /** Approved person-hours (each participant's own credited minutes). */
  hours: number;
  /** Students credited with time on this log. */
  memberIds: string[];
  peopleReached: number;
  sdg: number | null;
  cityKey: string | null;
  partners: string[];
  verifiedAt: string;
};

function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number) {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Nearest listed city to a `lat,lng` pin, if one is close enough. */
export function cityKeyFromPin(pin: string | null | undefined): string | null {
  const [lat, lon] = (pin ?? '').split(',').map((s) => Number(s.trim()));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  let best: { key: string; km: number } | null = null;
  for (const [key, geo] of Object.entries(PAKISTAN_CITY_GEO)) {
    const km = distanceKm(lat, lon, geo.lat, geo.lon);
    if (!best || km < best.km) best = { key, km };
  }
  return best && best.km <= PIN_CITY_MAX_KM ? best.key : null;
}

/** A listed city named in free venue text ("Liberty Market, Lahore"), longest name first. */
export function cityKeyFromText(
  text: string | null | undefined,
): string | null {
  const t = ` ${(text ?? '').toLowerCase().replace(/[^a-z]+/g, ' ')} `;
  if (!t.trim()) return null;
  const keys = Object.keys(PAKISTAN_CITY_GEO).sort(
    (a, b) => b.length - a.length,
  );
  return keys.find((k) => t.includes(` ${k} `)) ?? null;
}

/** Pin first, then the venue text, then the lead student's profile city (as reports use). */
export function quickWorkLedgerEntry(
  log: QuickWorkLedgerLog,
  leadCity: string | null | undefined,
): QuickWorkLedgerEntry {
  const credited = (log.participants ?? []).filter(
    (p) => Number(p.minutes) > 0,
  );
  const minutes = credited.reduce((a, p) => a + Number(p.minutes), 0);
  const sdg = Number(log.sdg);
  const partners = [...(log.partners ?? []), log.host ?? '']
    .map((p) => p.trim())
    .filter(Boolean);
  const verifiedAt = log.reviewedAt ?? log.updatedAt;
  return {
    logId: log.id,
    title: log.title || 'Quick Community Work',
    hours: minutes / 60,
    memberIds: [...new Set(credited.map((p) => p.userId))],
    peopleReached: Math.max(0, Number(log.peopleReached) || 0),
    sdg: Number.isInteger(sdg) && sdg >= 1 && sdg <= 17 ? sdg : null,
    cityKey:
      cityKeyFromPin(log.locationPin) ??
      cityKeyFromText(log.location) ??
      normalizeCityKey(leadCity),
    partners,
    verifiedAt: (verifiedAt instanceof Date
      ? verifiedAt
      : new Date(verifiedAt)
    ).toISOString(),
  };
}

/**
 * Community-service hour tiers shown to students and in admin reporting. Highest tier first; a
 * student's tier is the first one whose minimum their verified hours reach.
 */
export const HEC_HOUR_TIERS = [
  { code: 'full', min: 48, label: 'Full 3-credit equivalent (48+ h)' },
  { code: 'advanced', min: 32, label: 'Advanced (32–47.9 h)' },
  { code: 'recognized', min: 16, label: 'Recognized (16–31.9 h)' },
  { code: 'below', min: 0, label: 'Below 16 h' },
] as const;

export type HecHourTierCode = (typeof HEC_HOUR_TIERS)[number]['code'];

export function hecHourTier(hours: number): HecHourTierCode {
  const h = Number.isFinite(hours) ? hours : 0;
  return (HEC_HOUR_TIERS.find((t) => h >= t.min) ?? HEC_HOUR_TIERS[3]).code;
}

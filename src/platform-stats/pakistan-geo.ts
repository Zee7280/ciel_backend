/**
 * Static geography for the public impact map — simplified Pakistan outline/province lines and a
 * lon/lat lookup for every city in the canonical region list (kept in sync with
 * ciel_frontend/src/utils/pakistanRegions.ts's PAKISTAN_REGION_OPTIONS and this backend's own
 * admin.service.ts STAKEHOLDER_REGION_CANONICAL). None of this is business data — it's public
 * geographic fact, safe to hardcode once.
 */

/** [lon, lat] pairs tracing a simplified Pakistan border. */
export const PAKISTAN_MAP_OUTLINE: [number, number][] = [
  [61.6, 25.2],
  [62.4, 25.15],
  [63.5, 25.35],
  [64.6, 25.2],
  [65.6, 25.4],
  [66.5, 25.45],
  [66.8, 25.0],
  [67.2, 24.7],
  [67.5, 24.1],
  [68.2, 23.7],
  [68.8, 23.8],
  [69.6, 24.3],
  [70.6, 24.6],
  [71.1, 24.6],
  [70.7, 25.4],
  [70.1, 26.1],
  [69.5, 26.8],
  [69.9, 27.5],
  [70.4, 28.0],
  [70.8, 28.6],
  [71.9, 29.3],
  [72.5, 29.9],
  [73.3, 30.3],
  [74.1, 31.1],
  [74.6, 31.7],
  [74.6, 32.4],
  [75.1, 32.8],
  [74.4, 33.6],
  [73.9, 34.1],
  [74.3, 34.8],
  [75.3, 35.0],
  [76.2, 35.3],
  [77.0, 35.5],
  [77.8, 35.5],
  [76.9, 36.2],
  [75.9, 36.8],
  [75.4, 37.0],
  [74.6, 37.1],
  [73.8, 36.9],
  [72.6, 36.9],
  [71.8, 36.5],
  [71.2, 36.1],
  [71.6, 35.3],
  [71.0, 34.6],
  [71.1, 34.0],
  [70.3, 33.4],
  [69.9, 33.1],
  [69.5, 32.6],
  [69.3, 31.9],
  [68.5, 31.8],
  [67.6, 31.4],
  [66.9, 31.3],
  [66.3, 30.4],
  [66.4, 29.9],
  [65.0, 29.5],
  [63.5, 29.4],
  [62.4, 29.4],
  [61.0, 29.7],
  [60.9, 29.0],
  [61.6, 28.4],
  [62.5, 27.4],
  [63.2, 27.2],
  [63.2, 26.6],
  [62.0, 26.4],
  [61.8, 25.9],
];

/** Simplified internal province divider strokes, [lon, lat] pairs per line. */
export const PAKISTAN_PROVINCE_LINES: [number, number][][] = [
  [
    [67.4, 24.6],
    [68.0, 26.8],
    [69.6, 27.8],
  ],
  [
    [69.6, 27.8],
    [70.2, 28.7],
    [69.8, 30.4],
    [70.5, 31.9],
    [71.3, 33.4],
    [72.6, 34.0],
    [73.9, 34.1],
  ],
  [
    [70.5, 31.9],
    [69.6, 31.9],
  ],
  [
    [71.3, 33.4],
    [70.3, 33.4],
  ],
  [
    [72.6, 34.0],
    [72.8, 35.2],
    [74.3, 34.8],
  ],
];

/** [label, lon, lat] province name placements. */
export const PAKISTAN_PROVINCE_LABELS: [string, number, number][] = [
  ['BALOCHISTAN', 64.8, 28.2],
  ['SINDH', 69.0, 25.8],
  ['PUNJAB', 72.4, 30.9],
  ['KHYBER PAKHTUNKHWA', 69.6, 34.9],
  ['GILGIT-BALTISTAN', 75.6, 36.1],
];

/** Same simplified equirectangular projection as the reference design, tuned to a 560×500 viewBox. */
export function projectLonLat(lon: number, lat: number): [number, number] {
  return [(lon - 60.5) * 30 + 10, (37.5 - lat) * 35 + 10];
}

export type CityGeo = {
  name: string;
  province: string;
  lat: number;
  lon: number;
};

/** Real public coordinates for every actual city in PAKISTAN_REGION_OPTIONS (province/territory-only
 * entries like "Punjab" or "Balochistan" are intentionally omitted — they're not a point on a map). */
export const PAKISTAN_CITY_GEO: Record<string, CityGeo> = {
  abbottabad: {
    name: 'Abbottabad',
    province: 'Khyber Pakhtunkhwa',
    lat: 34.1463,
    lon: 73.2117,
  },
  attock: { name: 'Attock', province: 'Punjab', lat: 33.7666, lon: 72.3597 },
  bahawalnagar: {
    name: 'Bahawalnagar',
    province: 'Punjab',
    lat: 29.9998,
    lon: 73.2555,
  },
  bahawalpur: {
    name: 'Bahawalpur',
    province: 'Punjab',
    lat: 29.3956,
    lon: 71.6836,
  },
  charsadda: {
    name: 'Charsadda',
    province: 'Khyber Pakhtunkhwa',
    lat: 34.1483,
    lon: 71.7375,
  },
  chiniot: { name: 'Chiniot', province: 'Punjab', lat: 31.72, lon: 72.9784 },
  'dera ghazi khan': {
    name: 'Dera Ghazi Khan',
    province: 'Punjab',
    lat: 30.0561,
    lon: 70.6339,
  },
  'dera ismail khan': {
    name: 'Dera Ismail Khan',
    province: 'Khyber Pakhtunkhwa',
    lat: 31.8314,
    lon: 70.9017,
  },
  faisalabad: {
    name: 'Faisalabad',
    province: 'Punjab',
    lat: 31.4504,
    lon: 73.135,
  },
  gilgit: {
    name: 'Gilgit',
    province: 'Gilgit-Baltistan',
    lat: 35.9208,
    lon: 74.3144,
  },
  gujranwala: {
    name: 'Gujranwala',
    province: 'Punjab',
    lat: 32.1877,
    lon: 74.1945,
  },
  gujrat: { name: 'Gujrat', province: 'Punjab', lat: 32.5731, lon: 74.0789 },
  haripur: {
    name: 'Haripur',
    province: 'Khyber Pakhtunkhwa',
    lat: 33.9964,
    lon: 72.9313,
  },
  hyderabad: {
    name: 'Hyderabad',
    province: 'Sindh',
    lat: 25.396,
    lon: 68.3578,
  },
  islamabad: {
    name: 'Islamabad',
    province: 'Islamabad Capital Territory',
    lat: 33.6844,
    lon: 73.0479,
  },
  jhang: { name: 'Jhang', province: 'Punjab', lat: 31.2781, lon: 72.3317 },
  kamoke: { name: 'Kamoke', province: 'Punjab', lat: 32.097, lon: 74.2266 },
  karachi: { name: 'Karachi', province: 'Sindh', lat: 24.8607, lon: 67.0011 },
  kasur: { name: 'Kasur', province: 'Punjab', lat: 31.1191, lon: 74.4467 },
  kohat: {
    name: 'Kohat',
    province: 'Khyber Pakhtunkhwa',
    lat: 33.59,
    lon: 71.44,
  },
  lahore: { name: 'Lahore', province: 'Punjab', lat: 31.5497, lon: 74.3436 },
  larkana: { name: 'Larkana', province: 'Sindh', lat: 27.559, lon: 68.212 },
  'mandi bahauddin': {
    name: 'Mandi Bahauddin',
    province: 'Punjab',
    lat: 32.585,
    lon: 73.4909,
  },
  mansehra: {
    name: 'Mansehra',
    province: 'Khyber Pakhtunkhwa',
    lat: 34.333,
    lon: 73.2,
  },
  mardan: {
    name: 'Mardan',
    province: 'Khyber Pakhtunkhwa',
    lat: 34.1989,
    lon: 72.0404,
  },
  mingora: {
    name: 'Mingora',
    province: 'Khyber Pakhtunkhwa',
    lat: 34.7717,
    lon: 72.36,
  },
  'mirpur khas': {
    name: 'Mirpur Khas',
    province: 'Sindh',
    lat: 25.5266,
    lon: 69.0113,
  },
  multan: { name: 'Multan', province: 'Punjab', lat: 30.1575, lon: 71.5249 },
  murree: { name: 'Murree', province: 'Punjab', lat: 33.907, lon: 73.3943 },
  nawabshah: { name: 'Nawabshah', province: 'Sindh', lat: 26.2442, lon: 68.41 },
  okara: { name: 'Okara', province: 'Punjab', lat: 30.8081, lon: 73.4534 },
  peshawar: {
    name: 'Peshawar',
    province: 'Khyber Pakhtunkhwa',
    lat: 34.0151,
    lon: 71.5249,
  },
  quetta: {
    name: 'Quetta',
    province: 'Balochistan',
    lat: 30.1798,
    lon: 66.975,
  },
  'rahim yar khan': {
    name: 'Rahim Yar Khan',
    province: 'Punjab',
    lat: 28.4212,
    lon: 70.2989,
  },
  rawalpindi: {
    name: 'Rawalpindi',
    province: 'Punjab',
    lat: 33.5651,
    lon: 73.0169,
  },
  sahiwal: { name: 'Sahiwal', province: 'Punjab', lat: 30.6682, lon: 73.1114 },
  sargodha: {
    name: 'Sargodha',
    province: 'Punjab',
    lat: 32.0836,
    lon: 72.6711,
  },
  sheikhupura: {
    name: 'Sheikhupura',
    province: 'Punjab',
    lat: 31.713,
    lon: 73.9783,
  },
  sialkot: { name: 'Sialkot', province: 'Punjab', lat: 32.4945, lon: 74.5229 },
  skardu: {
    name: 'Skardu',
    province: 'Gilgit-Baltistan',
    lat: 35.2971,
    lon: 75.6333,
  },
  sukkur: { name: 'Sukkur', province: 'Sindh', lat: 27.7052, lon: 68.8574 },
  swabi: {
    name: 'Swabi',
    province: 'Khyber Pakhtunkhwa',
    lat: 34.12,
    lon: 72.47,
  },
  taxila: { name: 'Taxila', province: 'Punjab', lat: 33.7461, lon: 72.7861 },
  'wah cantonment': {
    name: 'Wah Cantonment',
    province: 'Punjab',
    lat: 33.796,
    lon: 72.708,
  },
};

/** Matches a free-text city (e.g. from User.city) against the canonical geo table. Returns the
 * lookup key, or null if it doesn't confidently resolve to a known city — callers should still
 * count an unresolved city in platform-wide totals, just not plot it on the map. */
export function normalizeCityKey(raw?: string | null): string | null {
  if (!raw) return null;
  const t = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t) return null;
  if (t === 'islamabad capital territory') return 'islamabad';
  return PAKISTAN_CITY_GEO[t] ? t : null;
}

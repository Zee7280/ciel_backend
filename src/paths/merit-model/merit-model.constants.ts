/** Course Project Merit Model — rubric constants.
 * CRIT and GRADE_BANDS implement the "CIEL PK Universal Coursework Quality Rubric" (design
 * reference: CIEL_PK_Coursework_Form_v6_Universal_Rubric_Evidence.html) — same 7-criterion,
 * 100-point structure and band calibration shown to students before they submit. The lookup
 * tables (EVPTS/INTEG/ORIGB/SDGCOL/METRIC_STATUS_TO_EVS) are unchanged from the earlier
 * "Coursework Merit Model" prototype and are reused — deterministically — inside the new
 * criteria's formulas in merit-model.util.ts.
 */

/** Evidence status -> points (used by the "Substance of results" criterion). */
export const EVPTS: Record<string, number> = {
    'Actual measured result': 12,
    'Qualitative evidence': 10,
    'Estimated / projected': 7,
    'Proposed target': 6,
    'Conceptual recommendation': 5,
    'Not measured yet': 3,
    'Not applicable': 4,
};

/** SDG integration level -> points (used by the "Sustainability & SDG authenticity" criterion).
 * Keys are the coursework-final-form's own `c_integ` chip labels (emoji-stripped — the entry's raw
 * value is normalized via stripEmojiPrefix before this lookup), NOT the merit-model prototype's own
 * demo vocabulary, which drifted from the real form and never matched real submissions. */
export const INTEG: Record<string, number> = {
    'Central to the work and demonstrated': 8,
    'Clearly connected, outcome not measured': 6,
    'Partially integrated': 4,
    'Indirectly connected': 3,
    'Identified retrospectively': 3,
};

/** SDG origin -> points (used by the "Sustainability & SDG authenticity" criterion). Keys are the
 * final-form's own `c_orig` chip labels (emoji-stripped), for the same reason as INTEG above. */
export const ORIGB: Record<string, number> = {
    'Introduced by the student / team': 4,
    'Emerged during the work': 3,
    'Identified when reviewing the completed work': 3,
    'Suggested by the instructor': 2,
    'Built into the course': 1,
    'Built into the assignment': 1,
};

/** SDG number -> brand color, for clients that want to render the same badge colors as the
 * coursework-final-form's own SDGS table (all 17 goals — the form offers all of them). */
export const SDGCOL: Record<number, string> = {
    1: '#E5243B',
    2: '#DDA63A',
    3: '#4C9F38',
    4: '#C5192D',
    5: '#FF3A21',
    6: '#26BDE2',
    7: '#FCC30B',
    8: '#A21942',
    9: '#FD6925',
    10: '#DD1367',
    11: '#FD9D24',
    12: '#BF8B2E',
    13: '#3F7E44',
    14: '#0A97D9',
    15: '#56C02B',
    16: '#00689D',
    17: '#19486A',
};

/** The 7 Universal Quality Rubric criteria in order, with their weight and accent color.
 * Evidence & integrity are verification safeguards under this rubric — not bonus-point
 * categories — so unlike the old prototype there is no separate "Verifiability" line; a
 * claims-vs-evidence consistency check is still surfaced (see scorecard()'s integrityFlag)
 * but never subtracted from or added to the 100-point total. */
export const CRIT: Array<{ key: string; label: string; max: number; color: string }> = [
    { key: 'task', label: '1 · Task / purpose & alignment', max: 10, color: '#7c3aed' },
    { key: 'knowledge', label: '2 · Knowledge, context & contribution', max: 15, color: '#c98a04' },
    { key: 'method', label: '3 · Method / process & disciplinary rigor', max: 20, color: '#0f766e' },
    { key: 'output', label: '4 · Quality of output / execution', max: 15, color: '#ea580c' },
    { key: 'analysis', label: '5 · Analysis, findings & application', max: 20, color: '#2563eb' },
    { key: 'sustainability', label: '6 · Sustainability & SDG integration', max: 15, color: '#3F7E44' },
    { key: 'reflection', label: '7 · Reflection, limitations & learning', max: 5, color: '#db2777' },
];

/** Band calibration, in descending threshold order — first match wins. Mirrors the design's
 * "0–39 Insufficient · 40–54 Basic · 55–64 Developing · 65–74 Good · 75–84 Very Good ·
 * 85–94 Excellent · 95–100 Outstanding" — 90+ is not routine: it requires the strongest
 * criteria to themselves land at Excellent/Outstanding, which the formulas below don't hand
 * out for free. */
export const GRADE_BANDS: Array<{ min: number; label: string; color: string }> = [
    { min: 95, label: 'OUTSTANDING', color: '#16a34a' },
    { min: 85, label: 'EXCELLENT', color: '#22c55e' },
    { min: 75, label: 'VERY GOOD', color: '#0f766e' },
    { min: 65, label: 'GOOD', color: '#2563eb' },
    { min: 55, label: 'DEVELOPING', color: '#c98a04' },
    { min: 40, label: 'BASIC', color: '#ea580c' },
    { min: 0, label: 'INSUFFICIENT', color: '#dc2626' },
];

/** New (not in the prototype, which never derived these from real text): word-count thresholds for
 * the free-text quality heuristics — below this many words a statement reads as present-but-vague. */
export const AIM_CLEAR_MIN_WORDS = 15;
export const REFLECTION_SUBSTANTIVE_MIN_WORDS = 15;

/** Bridges CourseProjectMetric.status (the wizard's own vocabulary — the final-form's MSTAT array)
 * to the exact EVPTS key strings the prototype's formulas expect, so results.pts stays byte-identical
 * to the reference design. */
export const METRIC_STATUS_TO_EVS: Record<string, string> = {
    'Actual — measured': 'Actual measured result',
    'Target — intended future result': 'Proposed target',
    'Estimated / projected': 'Estimated / projected',
    'Proposed — not yet tested': 'Conceptual recommendation',
};

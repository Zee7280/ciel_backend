/** Course Project Merit Model — rubric constants.
 * Ported 1:1 from the "Coursework Merit Model" prototype (EVPTS/INTEG/ORIGB/SDGCOL/CRIT and the
 * grade bands) so the point values and lookup tables stay byte-identical to the reference design.
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

/** The 7 rubric criteria in order, with their weight and accent color. */
export const CRIT: Array<{ key: string; label: string; max: number; color: string }> = [
    { key: 'sdg', label: '1 · Sustainability & SDG authenticity', max: 25, color: '#3F7E44' },
    { key: 'results', label: '2 · Substance of results', max: 20, color: '#c98a04' },
    { key: 'purpose', label: '3 · Clarity & quality of idea', max: 14, color: '#2563eb' },
    { key: 'rigor', label: '4 · Rigor (pathway-adjusted)', max: 13, color: '#0f766e' },
    { key: 'honesty', label: '5 · Honesty & consistency', max: 15, color: '#dc2626' },
    { key: 'refl', label: '6 · Reflection & transfer', max: 8, color: '#7c3aed' },
    { key: 'ver', label: '7 · Verifiability', max: 5, color: '#0e7490' },
];

/** Grade bands, in descending threshold order — first match wins. */
export const GRADE_BANDS: Array<{ min: number; label: string; color: string }> = [
    { min: 85, label: 'EXEMPLARY', color: '#16a34a' },
    { min: 70, label: 'STRONG', color: '#0f766e' },
    { min: 55, label: 'DEVELOPING', color: '#c98a04' },
    { min: 0, label: 'EMERGING', color: '#7a8095' },
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

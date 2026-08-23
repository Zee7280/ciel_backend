/** FYP Merit Model — rubric constants.
 * Ported 1:1 from the "FYP Merit Model" prototype (EVPTS/ROUTECOL/CRIT and the grade bands, the
 * latter shared with the Course Project rubric via merit-model.constants.ts) so point values and
 * lookup tables stay byte-identical to the reference design.
 */

/** Evidence status -> points (used by the "Substance of outcome" criterion). */
export const EVPTS: Record<string, number> = {
    'Measured / tested': 12,
    'Qualitative': 10,
    'Work itself, documented': 11,
    'Estimated / projected': 7,
    'Conceptual': 5,
    'Not yet': 3,
};

/** Route -> [accent color, background, emoji], for clients that want to render the same route badges. */
export const ROUTECOL: Record<string, [string, string, string]> = {
    scholar: ['#2563eb', '#e8effe', '📜'],
    maker: ['#c98a04', '#fdf3dd', '🎨'],
    builder: ['#0f766e', '#e0f3f1', '🖥️'],
    storyteller: ['#db2777', '#fdeaf3', '🎬'],
    consultant: ['#7c3aed', '#f1eafe', '📊'],
};

/** The 7 rubric criteria in order, with their weight and accent color. */
export const CRIT: Array<{ key: string; label: string; max: number; color: string }> = [
    { key: 'purpose', label: '1 · Purpose & originality', max: 15, color: '#2563eb' },
    { key: 'rigor', label: '2 · Rigor (route-adjusted)', max: 15, color: '#0f766e' },
    { key: 'outcome', label: '3 · Substance of outcome', max: 20, color: '#c98a04' },
    { key: 'honesty', label: '4 · Scholarly honesty', max: 15, color: '#dc2626' },
    { key: 'sdg', label: '5 · SDG authenticity', max: 15, color: '#3F7E44' },
    { key: 'pot', label: '6 · Potential & continuation', max: 10, color: '#db2777' },
    { key: 'conn', label: '7 · Completeness & connection', max: 10, color: '#7c3aed' },
];

/** New (not in the prototype, which never derived these from real form data): word-count thresholds
 * for the free-text quality heuristics, reused from the Course Project thresholds for consistency. */
export const AIM_CLEAR_MIN_WORDS = 15;
export const LIMITATION_SUBSTANTIVE_MIN_WORDS = 15;

/** Bridges the final-form's 7-option evidence ladder to the exact EVPTS key strings the merit-model
 * formulas expect. 'Not applicable' has no entry — it falls through the formulas' own `EVPTS[c.evs]||3`
 * default, the same honest floor the prototype itself relies on for unmapped values. */
export const FYP_EVIDENCE_STATUS_TO_EVS: Record<string, string> = {
    'Measured / tested result': 'Measured / tested',
    'Qualitative evidence': 'Qualitative',
    'The work itself is the evidence': 'Work itself, documented',
    'Estimated / projected': 'Estimated / projected',
    'Conceptual / proposed': 'Conceptual',
    'Not measured yet': 'Not yet',
};

/** Bridges the final-form's project-type chip labels to one of the 5 routes — ported from the
 * final-form's own TYPEMODE map. */
export const TYPE_TO_ROUTE: Record<string, string> = {
    'Thesis / dissertation': 'scholar',
    'Empirical research study': 'scholar',
    'Law dissertation / case-law study': 'scholar',
    'Action research / teaching practicum': 'scholar',
    'Degree-show collection': 'maker',
    'Design project (brief-based)': 'maker',
    'Architecture / built design': 'maker',
    'Performance / curation': 'maker',
    'Engineering capstone (design-build-test)': 'builder',
    'Software / engineering build': 'builder',
    'Film / media production': 'storyteller',
    'Industry / consulting project': 'consultant',
};

export const FYP_ROUTES = ['scholar', 'maker', 'builder', 'storyteller', 'consultant'] as const;

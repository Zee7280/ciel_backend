import { VentureEntry } from './entities/venture-entry.entity';

/**
 * Weighted checklist for the Startup/Business visibility gate. Keep in sync with
 * `ciel_frontend/src/app/dashboard/student/paths/startup-business/ventureCompleteness.ts`.
 */
export const VENTURE_COMPLETENESS_ITEMS: Array<{
    key: string;
    label: string;
    weight: number;
    isComplete: (v: Partial<VentureEntry>) => boolean;
}> = [
    { key: 'ventureName', label: 'Add your venture name', weight: 15, isComplete: (v) => !!v.ventureName?.trim() },
    { key: 'description', label: 'Describe what your venture does', weight: 20, isComplete: (v) => !!v.description?.trim() && v.description.trim().length >= 30 },
    { key: 'stage', label: 'Set your venture stage', weight: 10, isComplete: (v) => !!v.stage?.trim() },
    { key: 'traction', label: 'Log at least one traction update', weight: 20, isComplete: (v) => (v.tractionRows?.length ?? 0) > 0 },
    { key: 'team', label: 'Add at least one team member', weight: 20, isComplete: (v) => (v.team?.length ?? 0) > 0 },
    { key: 'materials', label: 'Upload at least one supporting material', weight: 15, isComplete: (v) => (v.materialUrls?.length ?? 0) > 0 },
];

export const VENTURE_VISIBILITY_THRESHOLD = 70;

export function ventureCompletenessPercent(v: Partial<VentureEntry>): number {
    return VENTURE_COMPLETENESS_ITEMS.reduce((sum, item) => sum + (item.isComplete(v) ? item.weight : 0), 0);
}

export function ventureMissingItems(v: Partial<VentureEntry>): Array<{ key: string; label: string }> {
    return VENTURE_COMPLETENESS_ITEMS.filter((item) => !item.isComplete(v)).map(({ key, label }) => ({ key, label }));
}

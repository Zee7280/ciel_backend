/** Normalize titles for duplicate student-opportunity detection (SDG prefix, punctuation). */
export function normalizeOpportunityTitleForMatch(title: string): string {
    return String(title || '')
        .toLowerCase()
        .replace(/\(?\s*sdg\s*[-–]?\s*\d+\s*\)?/gi, ' ')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function significantWords(normalized: string): string[] {
    return normalized.split(' ').filter((w) => w.length > 2);
}

/** True when two titles are the same project name (exact, substring, or strong word overlap). */
export function opportunityTitlesAreSimilar(a: string, b: string): boolean {
    const na = normalizeOpportunityTitleForMatch(a);
    const nb = normalizeOpportunityTitleForMatch(b);
    if (!na || !nb) return false;
    if (na === nb) return true;

    const minLen = 10;
    if (na.length >= minLen && nb.length >= minLen) {
        if (na.includes(nb) || nb.includes(na)) return true;
    }

    const wordsA = significantWords(na);
    const wordsB = significantWords(nb);
    if (wordsA.length < 2 || wordsB.length < 2) return false;

    const [shorter, longer] = wordsA.length <= wordsB.length ? [wordsA, wordsB] : [wordsB, wordsA];
    const longerSet = new Set(longer);
    const overlap = shorter.filter((w) => longerSet.has(w)).length;
    return overlap / shorter.length >= 0.75;
}

export function pickOpportunityUniversityNames(opp: {
    restricted_universities?: string[] | null;
    participation_scope?: { creator_university_name?: string } | null;
    visibility_and_academic_linkage?: { restricted_university_names?: string[] } | null;
}): string[] {
    const names: string[] = [];
    if (Array.isArray(opp.restricted_universities)) {
        for (const u of opp.restricted_universities) {
            const t = String(u || '').trim().toLowerCase();
            if (t) names.push(t);
        }
    }
    const scopeUni = opp.participation_scope?.creator_university_name;
    if (typeof scopeUni === 'string' && scopeUni.trim()) {
        names.push(scopeUni.trim().toLowerCase());
    }
    const vis = opp.visibility_and_academic_linkage?.restricted_university_names;
    if (Array.isArray(vis)) {
        for (const u of vis) {
            const t = String(u || '').trim().toLowerCase();
            if (t) names.push(t);
        }
    }
    return [...new Set(names)];
}

export function opportunityMatchesUniversity(
    opp: Parameters<typeof pickOpportunityUniversityNames>[0],
    universityNorm: string,
): boolean {
    const uni = universityNorm.trim().toLowerCase();
    if (!uni) return true;
    const names = pickOpportunityUniversityNames(opp);
    if (names.length === 0) return true;
    return names.some((n) => n === uni || n.includes(uni) || uni.includes(n));
}

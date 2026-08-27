import { CourseProjectEntry } from '../entities/course-project-entry.entity';
import {
    AIM_CLEAR_MIN_WORDS,
    EVPTS,
    GRADE_BANDS,
    INTEG,
    METRIC_STATUS_TO_EVS,
    ORIGB,
    REFLECTION_SUBSTANTIVE_MIN_WORDS,
    SDGCOL,
} from './merit-model.constants';
import { MeritCard, MeritCriterionScore, MeritGrade, MeritInputs, MeritQualityProfile, MeritScorecard } from './merit-model.types';

const clamp = (min: number, max: number, v: number) => Math.max(min, Math.min(max, v));
const wordCount = (text?: string | null) => (text || '').trim().split(/\s+/).filter(Boolean).length;
const nonEmpty = (text?: string | null) => !!text?.trim();
/** Strips a leading emoji/symbol prefix off a chip label, e.g. "🌱 Central to the work and
 * demonstrated" -> "Central to the work and demonstrated" — the final-form's own chips carry an
 * emoji the student never typed, so lookups must normalize past it. */
const stripEmojiPrefix = (s: string) => s.replace(/^[^\w]*\s*/, '').trim();

/** Evidence status derivation — "best evidence wins": maps each metric with a value through the
 * status vocabulary bridge and takes the highest-scoring one; falls back to the measured/findings/
 * module-inclusion signals when no metric carries a recognized, valued status. Never a fabricated
 * zero — the honest floor is 'Not measured yet' (still worth 3 base points), matching the prototype. */
function deriveEvidence(entry: CourseProjectEntry): { evs: string; num: string; numOk: 0 | 1 } {
    const resultsInfo = entry.resultsInfo;
    const metrics = resultsInfo?.metrics ?? [];
    const numOk: 0 | 1 = metrics.some((m) => nonEmpty(m.value) && !nonEmpty(m.status)) ? 0 : 1;

    let bestEvs: string | null = null;
    let bestPts = -1;
    let bestNum = '';
    for (const m of metrics) {
        if (!nonEmpty(m.value)) continue;
        const mapped = m.status ? METRIC_STATUS_TO_EVS[m.status] : undefined;
        if (!mapped) continue;
        const pts = EVPTS[mapped] ?? 0;
        if (pts > bestPts) {
            bestPts = pts;
            bestEvs = mapped;
            bestNum = [m.value, m.unit || m.unitOther].filter(Boolean).join(' ');
        }
    }
    if (bestEvs) return { evs: bestEvs, num: bestNum, numOk };

    // The final-form's c_meas chips are full sentences ("✅ Yes — a result was actually measured"),
    // not bare "Yes"/"Partly"/"Not yet" — match by normalized prefix, not exact equality.
    const measured = resultsInfo?.measured ? stripEmojiPrefix(resultsInfo.measured) : '';
    const findingsCount = resultsInfo?.findings?.length ?? 0;
    if ((measured.startsWith('Yes') || measured.startsWith('Partly')) && findingsCount > 0) {
        return { evs: 'Qualitative evidence', num: '', numOk };
    }
    if (measured.startsWith('Not yet')) return { evs: 'Not measured yet', num: '', numOk };
    if (entry.moduleInclusion?.find === false && findingsCount === 0) return { evs: 'Not applicable', num: '', numOk };
    return { evs: 'Not measured yet', num: '', numOk };
}

/** The year an entry became eligible (approval date), falling back to last-touched/created —
 * exported so the service's `year` filter derives the same value it's matching against. */
export function deriveMeritYear(entry: CourseProjectEntry): number {
    const source = entry.facultyApprovalAt ?? entry.updatedAt ?? entry.createdAt;
    return new Date(source).getFullYear();
}

/** Heuristic mapping from a real CourseProjectEntry's free-text/JSONB fields to the flat 0-2 /
 * 0-1 rubric inputs the scoring formulas expect. Deterministic and offline by design — see the
 * "Heuristic extraction table" in the Merit Model plan for the rationale behind each rule. */
export function extractMeritInputs(entry: CourseProjectEntry): MeritInputs {
    const studentInfo = entry.studentInfo;
    const assignmentInfo = entry.assignmentInfo;
    const aimsInfo = entry.aimsInfo;
    const processInfo = entry.processInfo;
    const resultsInfo = entry.resultsInfo;
    const sdgMapping = entry.sdgMapping;
    const reflectionInfo = entry.reflectionInfo;

    const format = assignmentInfo?.formats?.[0] || assignmentInfo?.format || 'Unspecified format';

    const aimWords = wordCount(aimsInfo?.aimStatement);
    const aim: 0 | 1 | 2 = aimWords === 0 ? 0 : aimWords < AIM_CLEAR_MIN_WORDS ? 1 : 2;

    const learnWords = wordCount(reflectionInfo?.lessonLearned);
    const learn: 0 | 1 | 2 = learnWords === 0 ? 0 : learnWords < REFLECTION_SUBSTANTIVE_MIN_WORDS ? 1 : 2;

    const hasMethods = (processInfo?.methods?.length ?? 0) > 0 || nonEmpty(processInfo?.methodsOther);
    const hasActivities = (processInfo?.activities?.length ?? 0) > 0 || nonEmpty(processInfo?.activitiesOther);
    const fit: 0 | 1 | 2 = hasMethods && hasActivities ? 2 : hasMethods || hasActivities ? 1 : 0;

    const findingsCount = resultsInfo?.findings?.length ?? 0;
    const hasSummary = nonEmpty(resultsInfo?.resultsSummary);
    const insight: 0 | 1 | 2 = findingsCount >= 2 ? 2 : findingsCount === 1 || hasSummary ? 1 : 0;

    const hasLimitation = nonEmpty(resultsInfo?.limitationType) || nonEmpty(resultsInfo?.limitationDetail);
    const hasLimitationEffect = nonEmpty(resultsInfo?.limitationInterpretation);
    const lim: 0 | 1 | 2 = hasLimitation && hasLimitationEffect ? 2 : hasLimitation ? 1 : 0;

    const { evs, num, numOk } = deriveEvidence(entry);

    const primary = sdgMapping?.notApplicable ? undefined : sdgMapping?.entries?.[0];
    const sdg = {
        p: primary?.goalNumber,
        target: ((primary?.targets?.length ?? 0) > 0 ? 1 : 0) as 0 | 1,
        how: (nonEmpty(primary?.how) ? 1 : 0) as 0 | 1,
    };

    const year = deriveMeritYear(entry);

    return {
        format,
        projectTitle: entry.projectTitle || entry.course || null,
        university: studentInfo?.universityName ?? null,
        discipline: studentInfo?.disciplineName ?? null,
        department: studentInfo?.department ?? null,
        semester: studentInfo?.semester ?? null,
        year,
        teacherName: studentInfo?.teacherName ?? null,
        teacherEmail: studentInfo?.teacherEmail ?? null,
        teamMode: studentInfo?.teamMode ?? null,

        aim,
        objs: aimsInfo?.objectives?.length ?? 0,
        issue: nonEmpty(assignmentInfo?.realWorldIssue) ? 1 : 0,

        fit,
        scale: nonEmpty(processInfo?.sampleScale) ? 1 : 0,

        output: (resultsInfo?.outputs?.length ?? 0) > 0 ? 1 : 0,
        insight,
        evs,
        num,
        numOk,

        sdg,
        // Normalized past the final-form chips' leading emoji so ORIGB/INTEG lookups actually hit.
        orig: sdgMapping?.origin ? stripEmojiPrefix(sdgMapping.origin) : '',
        integ: reflectionInfo?.integrationLevel
            ? stripEmojiPrefix(reflectionInfo.integrationLevel)
            : reflectionInfo?.sdgLinkHonesty
                ? stripEmojiPrefix(reflectionInfo.sdgLinkHonesty)
                : '',

        lim,

        learn,
        advice: nonEmpty(reflectionInfo?.adviceNextSemester) ? 1 : 0,
        next: nonEmpty(reflectionInfo?.nextSteps) || nonEmpty(reflectionInfo?.whatsNext) ? 1 : 0,
        skills: reflectionInfo?.skills?.length ?? 0,

        att: nonEmpty(entry.assignmentFileUrl) ? 1 : 0,
        evf: (entry.evidenceUrls?.length ?? 0) > 0 || (resultsInfo?.metrics?.some((m) => m.evidenceAttached) ?? false) ? 1 : 0,
    };
}

/** The 7-criterion rubric formulas — ported 1:1 from the prototype's scorecard(c). */
export function scorecard(c: MeritInputs): MeritScorecard {
    const sdg: MeritCriterionScore = {
        pts: clamp(0, 25, (c.sdg.p ? 6 : 0) + c.sdg.target * 4 + c.sdg.how * 5 + (INTEG[c.integ] || 2) + (ORIGB[c.orig] || 1) - 2),
        max: 25,
        note: `SDG ${c.sdg.p}${c.sdg.target ? ' + target' : ''}${c.sdg.how ? ' + explained link' : ''} · ${c.integ.toLowerCase()} · ${c.orig.toLowerCase()}`,
    };

    const results: MeritCriterionScore = {
        pts: Math.min(20, (EVPTS[c.evs] || 3) + c.output * 3 + c.insight * 2.5),
        max: 20,
        note: `${c.evs}${c.num ? ' — ' + c.num : ''}`,
    };

    const purpose: MeritCriterionScore = {
        pts: Math.min(14, c.aim * 4 + Math.min(c.objs, 3) * 1.3 + c.issue * 2.3),
        max: 14,
        note: c.aim === 2 ? 'Clear aim, concrete objectives, real issue named' : c.aim === 1 ? 'Aim present but loosely framed' : 'Aim missing or vague',
    };

    const rigor: MeritCriterionScore = {
        pts: Math.min(13, c.fit * 4.5 + c.scale * 3 + 1),
        max: 13,
        note:
            c.fit === 2
                ? `Method & activities fit the ${c.format.toLowerCase()} format${c.scale ? '; scale stated' : ''}`
                : c.fit === 1
                    ? 'Process only partly matches the declared format'
                    : 'Process poorly evidenced',
    };

    let hon = c.lim * 4 + c.numOk * 4 + 3;
    const claimsHigh = c.integ === 'Central to the work and demonstrated';
    const evLow = ['Not measured yet', 'Conceptual recommendation', 'Proposed target'].includes(c.evs);
    let flag: string;
    if (claimsHigh && evLow) {
        hon -= 4;
        flag = `⚠️ Consistency check: claims "central & demonstrated" but evidence is ${c.evs.toLowerCase()} — 4 points deducted.`;
    } else {
        flag = '✅ Consistency check passed: claims match the declared evidence.';
    }
    const honesty: MeritCriterionScore = {
        pts: Math.max(0, Math.min(15, hon)),
        max: 15,
        note: c.lim === 2 ? 'Limitation named with its effect' : c.lim === 1 ? 'Limitation named briefly' : 'No limitation acknowledged',
        flag,
    };

    const refl: MeritCriterionScore = {
        pts: Math.min(8, c.learn * 2.5 + c.advice * 1.5 + c.next * 1 + Math.min(c.skills, 4) * 0.4),
        max: 8,
        note: c.learn === 2 ? 'Substantive learning + advice to the next class' : c.learn === 1 ? 'Some reflection present' : 'Reflection thin',
    };

    const ver: MeritCriterionScore = {
        pts: Math.min(5, (c.att ? 3 : 0) + (c.evf ? 2 : 0)),
        max: 5,
        note: c.att
            ? '📎 Assignment attached — reviewers can open the actual work' + (c.evf ? ' · evidence files on metrics' : '')
            : c.evf
                ? 'Evidence files attached, assignment not'
                : 'Card-only record — no files attached (optional, but attached work ranks with higher confidence)',
    };

    const total = Math.round(sdg.pts + results.pts + purpose.pts + rigor.pts + honesty.pts + refl.pts + ver.pts);
    return { sdg, results, purpose, rigor, honesty, refl, ver, total };
}

/** Grade band lookup — ported 1:1 from the prototype's grade(t). */
export function grade(total: number): MeritGrade {
    const band = GRADE_BANDS.find((b) => total >= b.min) ?? GRADE_BANDS[GRADE_BANDS.length - 1];
    return { label: band.label, color: band.color };
}

/** Completeness x credibility quadrant — ported 1:1 from the prototype's compCred(c). */
export function compCred(c: MeritInputs): MeritQualityProfile {
    const compFields = [
        c.objs >= 2,
        !!c.scale,
        c.insight === 2,
        c.num !== '',
        c.lim === 2,
        !!c.advice,
        !!c.next,
        c.skills >= 3,
        !!c.sdg.target,
        !!c.sdg.how,
    ];
    const comp = compFields.filter(Boolean).length / compFields.length;

    const evLow = ['Not measured yet', 'Conceptual recommendation', 'Proposed target'].includes(c.evs);
    const credPts =
        (c.evs === 'Actual measured result' ? 2 : c.evs === 'Qualitative evidence' ? 1 : 0) +
        (c.att ? 2 : 0) +
        (c.evf ? 2 : 0) +
        (c.numOk ? 2 : 0) +
        (!(c.integ === 'Central to the work and demonstrated' && evLow) ? 2 : 0);
    const cred = credPts / 10;

    const badge =
        comp >= 0.6 && cred >= 0.6
            ? { icon: '🟢', label: 'RICH & CREDIBLE', color: '#16a34a', background: '#e8f8ee', description: 'tells the full story and can prove it' }
            : comp >= 0.6
                ? {
                    icon: '🟡',
                    label: 'RICH, THIN PROOF',
                    color: '#c98a04',
                    background: '#fdf3dd',
                    description: 'many sections filled, little verifiable — volume never beats evidence',
                }
                : cred >= 0.6
                    ? {
                        icon: '🔵',
                        label: 'LEAN BUT CREDIBLE',
                        color: '#2563eb',
                        background: '#e8effe',
                        description: 'fewer sections, but everything said is proven — honesty outranks volume',
                    }
                    : { icon: '⚪', label: 'LEAN & UNPROVEN', color: '#7a8095', background: '#f1f2f7', description: 'little told, little proven — scored for feedback' };

    return { completenessPercent: Math.round(comp * 100), credibilityPercent: Math.round(cred * 100), badge };
}

type MeritCriterionKey = Exclude<keyof MeritScorecard, 'total'>;
const CRITERION_KEYS: MeritCriterionKey[] = ['sdg', 'results', 'purpose', 'rigor', 'honesty', 'refl', 'ver'];

/** "Why this rank" generator — ported 1:1 from the prototype's reason(S,c): picks the top-2
 * scoring criteria (by percent-of-max) and stitches together their canned explanation bits. */
export function reason(S: MeritScorecard, c: MeritInputs): string {
    const parts = CRITERION_KEYS.map((key) => ({ key, ratio: S[key].pts / S[key].max }))
        .sort((a, b) => b.ratio - a.ratio)
        .slice(0, 2);
    const bits: Record<MeritCriterionKey, string> = {
        sdg: c.orig.toLowerCase().includes('student') ? 'a self-started, authentic sustainability core' : 'an authentic, explained sustainability core',
        results: c.evs.includes('measured result') ? 'real measured results — fruitful, not decorative' : 'substantive, honestly-classified results',
        purpose: 'a concise, real idea anyone can grasp',
        rigor: 'rigor true to its own format',
        honesty: 'honest limits & correctly classified numbers',
        refl: 'reflection that transfers to the next cohort',
        ver: 'the actual assignment attached — every claim openable and checkable',
    };
    return `${bits[parts[0].key]}, with ${bits[parts[1].key]}${c.att ? '. The attached work lets reviewers verify, not trust' : ''}`;
}

/** "🔮 Potential" forecast — ported 1:1 from the prototype's potential(c). */
export function potential(c: MeritInputs): string {
    const f = c.format.toLowerCase();
    const base =
        c.evs === 'Actual measured result'
            ? 'already proven at classroom scale'
            : c.evs === 'Proposed target'
                ? 'a costed plan sitting one approval from implementation'
                : c.evs === 'Qualitative evidence'
                    ? 'documented change, ready for a measured follow-up'
                    : c.evs === 'Estimated / projected'
                        ? 'a credible projection ready for a real-world pilot'
                        : 'an idea one pilot away from becoming evidence';
    const next = /software|app/.test(f)
        ? 'a natural FYP or Enterprise Path continuation'
        : /design|model|prototype/.test(f)
            ? 'prototype-to-pilot with a partner site next term'
            : /artwork|exhibition|campaign|media/.test(f)
                ? 'university-wide showcase and public-awareness scaling'
                : /practical|audit|lab|field/.test(f)
                    ? 'protocol adoption across other departments'
                    : 'handover to administration or the next cohort for implementation';
    return `${base} — most likely future course: ${next}.${c.orig.toLowerCase().includes('student') ? ' Founder-type initiative: flag to the Enterprise Path.' : ''}`;
}

/** Composes the full Merit Model card for one entry. */
export function computeMeritCard(entry: CourseProjectEntry): MeritCard {
    const inputs = extractMeritInputs(entry);
    const S = scorecard(inputs);
    return {
        id: entry.id,
        projectTitle: inputs.projectTitle,
        format: inputs.format,
        university: inputs.university,
        discipline: inputs.discipline,
        department: inputs.department,
        semester: inputs.semester,
        year: inputs.year,
        teacherName: inputs.teacherName,
        teamMode: inputs.teamMode,
        sdg: {
            goalNumber: inputs.sdg.p,
            color: inputs.sdg.p ? SDGCOL[inputs.sdg.p] : undefined,
            hasTarget: !!inputs.sdg.target,
            hasExplainedLink: !!inputs.sdg.how,
            origin: inputs.orig,
            integrationLevel: inputs.integ,
        },
        scorecard: S,
        grade: grade(S.total),
        qualityProfile: compCred(inputs),
        reason: reason(S, inputs),
        potential: potential(inputs),
    };
}

/** Ranking tie-break — ported 1:1 from the prototype's byMerit: total, then credibility, then completeness. */
export function byMerit(a: MeritCard, b: MeritCard): number {
    return (
        b.scorecard.total - a.scorecard.total ||
        b.qualityProfile.credibilityPercent - a.qualityProfile.credibilityPercent ||
        b.qualityProfile.completenessPercent - a.qualityProfile.completenessPercent
    );
}

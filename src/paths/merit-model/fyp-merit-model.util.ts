import { FypEntry, FypRouteDetails, FypTeamMember } from '../entities/fyp-entry.entity';
import { grade as sharedGrade } from './merit-model.util';
import {
    AIM_CLEAR_MIN_WORDS,
    EVPTS,
    FYP_EVIDENCE_STATUS_TO_EVS,
    LIMITATION_SUBSTANTIVE_MIN_WORDS,
    ROUTECOL,
    TYPE_TO_ROUTE,
} from './fyp-merit-model.constants';
import { FypMeritCard, FypMeritCriterionScore, FypMeritGrade, FypMeritInputs, FypMeritQualityProfile, FypMeritScorecard } from './fyp-merit-model.types';

const wordCount = (text?: string | null) => (text || '').trim().split(/\s+/).filter(Boolean).length;
const nonEmpty = (text?: string | null) => !!text?.trim();
/** Strips a leading emoji/symbol prefix off a chip label, e.g. "🧵 Degree-show collection" -> "Degree-show collection". */
const stripEmojiPrefix = (s: string) => s.replace(/^[^\w]*\s*/, '').trim();

function monthsBetween(a?: string | null, b?: string | null): number {
    if (!a || !b) return 0;
    const [y1, m1] = a.split('-').map(Number);
    const [y2, m2] = b.split('-').map(Number);
    if ([y1, m1, y2, m2].some((n) => Number.isNaN(n))) return 0;
    return (y2 - y1) * 12 + (m2 - m1) + 1;
}

/** The route the caller's leadRoute (or first project type) resolves to — falls back to 'scholar'. */
export function deriveFypRoute(entry: FypEntry): string {
    const projectInfo = entry.projectInfo;
    if (projectInfo?.leadRoute) return projectInfo.leadRoute;
    const typeLabel = projectInfo?.projectTypes?.[0] || projectInfo?.projectType;
    if (!typeLabel) return 'scholar';
    return TYPE_TO_ROUTE[stripEmojiPrefix(typeLabel)] || 'scholar';
}

/** "YYYY-MM" the work was completed — methodology.periodTo, falling back to last-touched. */
export function deriveFypCompletionMonth(entry: FypEntry): string {
    const periodTo = entry.methodology?.periodTo;
    if (periodTo && /^\d{4}-\d{2}/.test(periodTo)) return periodTo.slice(0, 7);
    return new Date(entry.updatedAt).toISOString().slice(0, 7);
}

const ROUTE_BLOCK_FIELDS: Record<string, Array<keyof FypRouteDetails>> = {
    maker: ['showMonth', 'piecesShown', 'juryExaminer'],
    builder: ['buildStatus', 'testersCount', 'iterationsCount'],
    storyteller: ['screeningMonth', 'audienceReached', 'runtimeFormat'],
    consultant: ['clientOrg', 'engagementBasis', 'recommendationStatus'],
    scholar: ['discussion', 'conclusion'],
};

/** How complete the route-specific block is (0 none / 1 partial / 2 all filled) — the prototype's
 * hand-set `blk` field, derived here from how many of the route's own fields are actually filled. */
function deriveRouteBlockCompleteness(route: string, routeDetails?: FypRouteDetails | null): 0 | 1 | 2 {
    const fields = ROUTE_BLOCK_FIELDS[route] ?? ROUTE_BLOCK_FIELDS.scholar;
    if (!routeDetails) return 0;
    const filled = fields.filter((f) => {
        const v = routeDetails[f];
        return typeof v === 'number' ? v > 0 : nonEmpty(v as string | undefined);
    }).length;
    if (filled === 0) return 0;
    return filled === fields.length ? 2 : 1;
}

/** External engagement signal (jury / testers / audience / client) — scholar has no such field, so
 * it's honestly always 0 for that route rather than guessed. */
function deriveExternalEngagement(route: string, routeDetails?: FypRouteDetails | null): 0 | 1 {
    if (!routeDetails) return 0;
    switch (route) {
        case 'maker':
            return nonEmpty(routeDetails.juryExaminer) ? 1 : 0;
        case 'builder':
            return (routeDetails.testersCount ?? 0) > 0 ? 1 : 0;
        case 'storyteller':
            return (routeDetails.audienceReached ?? 0) > 0 ? 1 : 0;
        case 'consultant':
            return nonEmpty(routeDetails.clientOrg) ? 1 : 0;
        default:
            return 0;
    }
}

/** Heuristic mapping from a real FypEntry's free-text/JSONB fields to the flat rubric inputs the
 * scoring formulas expect. Deterministic and offline by design, mirroring extractMeritInputs in
 * merit-model.util.ts for Course Project. */
export function extractFypMeritInputs(entry: FypEntry): FypMeritInputs {
    const projectInfo = entry.projectInfo;
    const objectivesInfo = entry.objectivesInfo;
    const methodology = entry.methodology;
    const findings = entry.findings;
    const sdgMapping = entry.sdgMapping;
    const reflectionInfo = entry.reflectionInfo;
    const repository = entry.repository;

    const route = deriveFypRoute(entry);

    const aimWords = wordCount(objectivesInfo?.aim);
    const aim: 0 | 1 | 2 = aimWords === 0 ? 0 : aimWords < AIM_CLEAR_MIN_WORDS ? 1 : 2;

    const hasWrong = nonEmpty(reflectionInfo?.wrongAssumption);
    // No field in the form actually captures "originality" — the closest honest proxy is whether the
    // aim is clearly stated AND the student names a tested assumption (real evidence of fresh thinking).
    const nov: 0 | 1 | 2 = aimWords === 0 ? 0 : hasWrong ? 2 : 1;

    const hasApproaches = (methodology?.approaches?.length ?? 0) > 0;
    const hasMethods = (methodology?.methods?.length ?? 0) > 0 || nonEmpty(methodology?.methodsOther);
    const fit: 0 | 1 | 2 = hasApproaches && hasMethods ? 2 : hasApproaches || hasMethods ? 1 : 0;

    const scaleEntriesCount = methodology?.scaleEntries?.length ?? 0;
    const scn = scaleEntriesCount > 0 ? scaleEntriesCount : nonEmpty(methodology?.sampleScale) ? 1 : 0;

    const dur = monthsBetween(methodology?.periodFrom, methodology?.periodTo);

    const fnd = findings?.findings?.length ?? 0;

    const evsRaw = findings?.evidenceStatus;
    const evs = evsRaw ? FYP_EVIDENCE_STATUS_TO_EVS[evsRaw] ?? evsRaw : 'Not yet';

    const metrics = findings?.metrics ?? [];
    const mm = metrics.filter((m) => m.status === 'Measured').length;
    const me = metrics.filter((m) => m.status === 'Estimated').length;
    const mt = metrics.filter((m) => m.status === 'Target').length;

    const limitationText = findings?.limitation || findings?.limitationDetail || findings?.limitationType || '';
    const limWords = wordCount(limitationText);
    const lim: 0 | 1 | 2 = limWords === 0 ? 0 : limWords < LIMITATION_SUBSTANTIVE_MIN_WORDS ? 1 : 2;

    const scope: 0 | 1 = nonEmpty(objectivesInfo?.scope) ? 1 : 0;
    const wrong: 0 | 1 = hasWrong ? 1 : 0;

    const primary = sdgMapping?.entries?.[0];
    const hasTgt = (primary?.targets?.length ?? 0) > 0;
    const hasHow = nonEmpty(primary?.how);
    const sdgState: 'linked' | 'none' | 'forced' = sdgMapping?.noSdgApplies
        ? 'none'
        : primary && (hasTgt || hasHow)
            ? 'linked'
            : 'forced';

    const blk = deriveRouteBlockCompleteness(route, entry.routeDetails);
    const ext = deriveExternalEngagement(route, entry.routeDetails);

    const whatsNext = reflectionInfo?.whatsNext;
    const fwd: 0 | 1 = nonEmpty(whatsNext) && !whatsNext!.trim().toLowerCase().startsWith('completed') ? 1 : 0;

    const repo: 0 | 1 = (entry.deliverables?.length ?? 0) > 0 || nonEmpty(repository?.externalLinks) ? 1 : 0;
    const teamMembers = projectInfo?.teamMembers ?? [];
    const linked: 0 | 1 = teamMembers.some(
        (tm): tm is FypTeamMember => typeof tm === 'object' && tm !== null && nonEmpty((tm as FypTeamMember).email),
    )
        ? 1
        : 0;
    const conf: 0 | 1 = entry.supervisorApprovalStatus === 'approved' ? 1 : 0;

    return {
        route,
        projectTitle: projectInfo?.title || entry.projectTitle || null,
        school: projectInfo?.school ?? null,
        supervisorName: projectInfo?.supervisorName ?? null,
        supervisorEmail: projectInfo?.supervisorEmail ?? null,
        span: projectInfo?.span ?? null,
        completionMonth: deriveFypCompletionMonth(entry),

        aim,
        objs: objectivesInfo?.objectives?.length ?? 0,
        nov,

        fit,
        scn,
        dur,

        fnd,
        evs,
        mm,
        me,
        mt,

        lim,
        scope,
        wrong,
        blk,

        sdg: sdgState,
        tgt: (hasTgt ? 1 : 0) as 0 | 1,
        how: (hasHow ? 1 : 0) as 0 | 1,

        fwd,
        ext,

        repo,
        linked,
        conf,
    };
}

/** The 7-criterion FYP rubric formulas — ported 1:1 from the prototype's scorecard(c). */
export function fypScorecard(c: FypMeritInputs): FypMeritScorecard {
    const purpose: FypMeritCriterionScore = {
        pts: Math.min(15, c.aim * 4 + Math.min(c.objs, 3) * 1.2 + c.nov * 2.6),
        max: 15,
        note:
            (c.nov === 2 ? 'A genuinely fresh angle — ' : c.nov === 1 ? 'A solid take — ' : 'An incremental take — ') +
            (c.aim === 2 ? 'purpose anyone can understand, concrete objectives' : 'purpose loosely framed'),
    };

    const rigor: FypMeritCriterionScore = {
        pts: Math.min(15, c.fit * 5 + Math.min(c.scn, 3) * 2 + (c.dur ? 2 : 0)),
        max: 15,
        note:
            (c.fit === 2 ? `Method fits the ${c.route} route` : c.fit === 1 ? 'Method partly matches the route' : 'Process thinly evidenced') +
            (c.scn ? ` · ${c.scn} scale entr${c.scn === 1 ? 'y' : 'ies'} via the standard builder` : ' · no scale declared (may be honest N/A)') +
            (c.dur ? ` · period stated (${c.dur} months)` : ''),
    };

    const nmet = c.mm + c.me + c.mt;
    const outcome: FypMeritCriterionScore = {
        pts: Math.min(20, (EVPTS[c.evs] || 3) + Math.min(c.fnd, 3) * 2.2 + Math.min(c.mm, 2) * 1.5),
        max: 20,
        note: `${c.evs} evidence · ${c.fnd} finding${c.fnd === 1 ? '' : 's'}${
            nmet
                ? ` · ${nmet} metric${nmet === 1 ? '' : 's'} on the card (${c.mm} measured${c.me ? ', ' + c.me + ' estimated' : ''}${
                    c.mt ? ', ' + c.mt + ' target' : ''
                } — all status-tagged)`
                : ' · no metrics (may be honest for this route)'
        }`,
    };

    let hon = c.lim * 4 + c.scope * 2 + c.wrong * 3 + 2;
    let flag = '✅ Consistency: claims match declared evidence — every number carries its status tag.';
    if (c.evs === 'Measured / tested' && c.mm === 0) {
        hon -= 3;
        flag = '⚠️ Claims "measured / tested" but no MEASURED-tagged metric on the card — 3 points deducted.';
    }
    if (c.route === 'maker' && c.evs === 'Work itself, documented' && c.blk === 0) {
        hon -= 3;
        flag = '⚠️ "Work itself is evidence" claimed but no documentation/degree-show details — 3 points deducted.';
    }
    const honesty: FypMeritCriterionScore = {
        pts: Math.max(0, Math.min(15, hon)),
        max: 15,
        note: c.lim === 2 ? 'Limitation named with its effect' : c.lim === 1 ? 'Limitation named briefly' : 'No limitation acknowledged',
        flag,
    };

    const sdg: FypMeritCriterionScore = {
        pts: c.sdg === 'none' ? 9 : c.sdg === 'forced' ? 3 : Math.min(15, 7 + c.tgt * 3 + c.how * 5),
        max: 15,
        note:
            c.sdg === 'none'
                ? 'Honest "no SDG applies" — respected, flagged for review'
                : c.sdg === 'forced'
                    ? 'SDG named without target or explanation — reads decorative'
                    : 'Genuine link' + (c.tgt ? ' + target' : '') + (c.how ? ' + explained' : ''),
    };

    const strongEvidence = ['Measured / tested', 'Work itself, documented'].includes(c.evs);
    const pot: FypMeritCriterionScore = {
        pts: Math.min(10, c.fwd * 3 + c.ext * 4 + (strongEvidence ? 3 : c.evs === 'Qualitative' ? 2 : 1)),
        max: 10,
        note: `${c.fwd ? 'Next step declared' : 'No next step declared'}${c.ext ? ' · external engagement (jury / client / industry) ✓' : ''}${
            strongEvidence ? ' · evidence strong enough to build on' : ''
        }`,
    };

    const conn: FypMeritCriterionScore = {
        pts: Math.min(10, c.repo * 3 + c.linked * 2 + c.conf * 3 + c.blk * 1),
        max: 10,
        note: `${c.repo ? 'Repository ✓' : 'No repository'}${c.linked ? ' · co-authors linked ✓' : ''}${
            c.conf ? ' · supervisor confirmed ✓' : ' · awaiting supervisor'
        }${c.blk === 2 ? ' · route block complete ✓' : c.blk === 1 ? ' · route block partial' : ''}`,
    };

    const total = Math.round(purpose.pts + rigor.pts + outcome.pts + honesty.pts + sdg.pts + pot.pts + conn.pts);
    return { purpose, rigor, outcome, honesty, sdg, pot, conn, total };
}

/** Grade band lookup — identical bands to Course Project's, reused rather than duplicated. */
export const fypGrade: (total: number) => FypMeritGrade = sharedGrade;

/** Completeness x credibility quadrant — ported 1:1 from the prototype's compCred(c), including
 * its own quirk: the prototype's credPts formula divides by 10 across 5 terms, but one term reads
 * `c.att`, a field never set on any of its demo cards (so it silently always contributed 0 there
 * too). Preserved here exactly — credibility caps at 80%, same as the reference prototype — rather
 * than "fixing" behavior the rubric author may or may not have intended. */
export function fypCompCred(c: FypMeritInputs): FypMeritQualityProfile {
    const compFields = [c.scn > 0, c.dur > 0, c.mm + c.me + c.mt > 0, c.fnd >= 2, !!c.scope, !!c.wrong, c.blk > 0, !!c.tgt, !!c.how, !!c.fwd];
    const comp = compFields.filter(Boolean).length / compFields.length;

    const strongEvidence = ['Measured / tested', 'Work itself, documented'].includes(c.evs);
    const credPts = (c.mm > 0 ? 2 : 0) + (c.conf ? 2 : 0) + (strongEvidence ? 2 : 0) + (!(c.evs === 'Measured / tested' && c.mm === 0) ? 2 : 0);
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
                    description: 'tells a full story but light on verifiable evidence — score capped by credibility, not volume',
                }
                : cred >= 0.6
                    ? {
                        icon: '🔵',
                        label: 'LEAN BUT CREDIBLE',
                        color: '#2563eb',
                        background: '#e8effe',
                        description: 'says little, proves what it says — honesty outranks volume',
                    }
                    : { icon: '⚪', label: 'LEAN & UNPROVEN', color: '#7a8095', background: '#f1f2f7', description: 'little told, little proven — scored for feedback' };

    return { completenessPercent: Math.round(comp * 100), credibilityPercent: Math.round(cred * 100), badge };
}

type FypCriterionKey = Exclude<keyof FypMeritScorecard, 'total'>;
const CRITERION_KEYS: FypCriterionKey[] = ['purpose', 'rigor', 'outcome', 'honesty', 'sdg', 'pot', 'conn'];

/** "Why picked" generator — ported 1:1 from the prototype's reason(S,c), including its literal
 * <b> markup (the prototype renders this straight into innerHTML). */
export function fypReason(S: FypMeritScorecard, c: FypMeritInputs): string {
    const ranked = CRITERION_KEYS.map((key) => ({ key, ratio: S[key].pts / S[key].max })).sort((a, b) => b.ratio - a.ratio);
    const phrase: Record<FypCriterionKey, string> = {
        outcome:
            c.evs === 'Measured / tested'
                ? `its results are proven, not promised — ${c.fnd} finding${c.fnd === 1 ? '' : 's'} backed by tested evidence`
                : c.evs === 'Work itself, documented'
                    ? `the finished work stands as its own evidence — fully documented${c.blk === 2 ? ' with the route record complete' : ''}`
                    : `its outcomes are substantive and honestly classified as ${c.evs.toLowerCase()}`,
        purpose:
            c.nov === 2
                ? `the idea itself is genuinely fresh — no one in this cohort has approached the problem this way`
                : `its purpose is sharply framed, with concrete objectives anyone can follow`,
        sdg:
            c.sdg === 'none'
                ? `it declares "no SDG applies" honestly rather than decorating — integrity the rubric rewards`
                : `its sustainability link is argued, targeted and verified — not a badge, a claim with evidence`,
        honesty: `it shows rare scholarly honesty: limits and scope declared, an assumption openly tested`,
        rigor: `its method discipline is true to the ${c.route} route — right tools, stated scale, declared period`,
        pot: c.ext
            ? `it already has forward motion — external partners (jury, client or industry) are engaged, not hypothetical`
            : `it names a realistic next step and its evidence is strong enough to build on`,
        conn: `the record is complete and fully connected — repository, co-authors, supervisor, route details`,
    };
    const value = c.ext
        ? `Bridges the university to ${c.route === 'consultant' ? 'industry' : 'real partners'} — exactly the showcase story that makes CIEL credible to employers and funders.`
        : c.nov === 2
            ? `A repository first: future cohorts will cite this record instead of starting from zero — compounding value for the platform.`
            : c.sdg !== 'none'
                ? `A verified SDG datapoint the university can cite to HEC and rankings — the currency CIEL trades in.`
                : `An honest benchmark for its route — the kind of baseline record that keeps the whole ranking trustworthy.`;
    return `<b>Why picked:</b> Above all, ${phrase[ranked[0].key]}. It backs this with a second strength: ${phrase[ranked[1].key]}. <b>Value to CIEL:</b> ${value}`;
}

/** "Most likely future course" forecast — ported 1:1 from the prototype's potential(c). */
export function fypPotential(c: FypMeritInputs): string {
    const base =
        c.evs === 'Measured / tested'
            ? 'proven at thesis scale'
            : c.evs === 'Work itself, documented'
                ? 'a finished, documented body of work'
                : c.evs === 'Qualitative'
                    ? 'documented change ready for a measured follow-up'
                    : c.evs === 'Estimated / projected'
                        ? 'a credible projection awaiting a real-world pilot'
                        : 'early-stage — one pilot from evidence';
    const next: Record<string, string> = {
        scholar: "publication or a funded master's continuation",
        maker: 'exhibition circuit, industry commissions, or production at scale',
        builder: 'deployment pilot — a natural Enterprise Path continuation',
        storyteller: 'festival circuit and public-broadcast licensing',
        consultant: 'client implementation and a case-study publication',
    };
    return `${base} — most likely future course: ${next[c.route] ?? next.scholar}.`;
}

/** Composes the full FYP Merit Model card for one entry. */
export function computeFypMeritCard(entry: FypEntry): FypMeritCard {
    const inputs = extractFypMeritInputs(entry);
    const S = fypScorecard(inputs);
    return {
        id: entry.id,
        projectTitle: inputs.projectTitle,
        route: inputs.route,
        routeColor: ROUTECOL[inputs.route] ?? ROUTECOL.scholar,
        school: inputs.school,
        supervisorName: inputs.supervisorName,
        span: inputs.span,
        completionMonth: inputs.completionMonth,
        scorecard: S,
        grade: fypGrade(S.total),
        qualityProfile: fypCompCred(inputs),
        reason: fypReason(S, inputs),
        potential: fypPotential(inputs),
    };
}

/** Ranking order — ported from the prototype's sort: eligibility is pre-filtered upstream (every
 * card here is already eligible), so this reduces to total desc, same as the prototype's second
 * sort key. */
export function byFypMerit(a: FypMeritCard, b: FypMeritCard): number {
    return b.scorecard.total - a.scorecard.total;
}

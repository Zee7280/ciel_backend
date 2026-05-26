import { StudentReport } from './entities/student-report.entity';

export type ReportEvidenceFileRef = {
    url: string;
    name: string;
    source: string;
};

function pickEvidenceUrl(value: unknown): string {
    if (typeof value === 'string') return value.trim();
    if (!value || typeof value !== 'object') return '';

    const record = value as Record<string, unknown>;
    const url =
        record.url ??
        record.evidence_url ??
        record.file_url ??
        record.location ??
        record.path;

    return typeof url === 'string' ? url.trim() : '';
}

function pickEvidenceName(value: unknown, fallback: string): string {
    if (typeof value === 'string') {
        const fromPath = value.split('?')[0].split('/').filter(Boolean).pop();
        return fromPath || fallback;
    }
    if (!value || typeof value !== 'object') return fallback;

    const record = value as Record<string, unknown>;
    const name = record.name ?? record.fileName ?? record.filename ?? record.originalName;
    return typeof name === 'string' && name.trim() ? name.trim() : fallback;
}

function addCandidate(
    map: Map<string, ReportEvidenceFileRef>,
    value: unknown,
    source: string,
    index: number,
) {
    const url = pickEvidenceUrl(value);
    if (!url || !/^https?:\/\//i.test(url) || map.has(url)) return;
    map.set(url, {
        url,
        name: pickEvidenceName(value, `${source}-${index + 1}`),
        source,
    });
}

function addFromList(map: Map<string, ReportEvidenceFileRef>, list: unknown, source: string) {
    if (Array.isArray(list)) {
        list.forEach((item, index) => addCandidate(map, item, source, index));
        return;
    }
    if (typeof list === 'string' || (list && typeof list === 'object')) {
        addCandidate(map, list, source, 0);
    }
}

/**
 * Canonical collector for all report-linked evidence URLs (admin bundles, exports).
 * Does not mutate reports or change student upload paths.
 */
export function collectReportEvidenceFiles(report: StudentReport): ReportEvidenceFileRef[] {
    const map = new Map<string, ReportEvidenceFileRef>();

    const sections = [
        { data: report.section1, key: 'section1' },
        { data: report.section2, key: 'section2' },
        { data: report.section3, key: 'section3' },
        { data: report.section4, key: 'section4' },
        { data: report.section5, key: 'section5' },
        { data: report.section6, key: 'section6' },
        { data: report.section7, key: 'section7' },
        { data: report.section8, key: 'section8' },
        { data: report.section9, key: 'section9' },
        { data: report.section10, key: 'section10' },
    ];

    for (const { data, key } of sections) {
        if (!data || typeof data !== 'object') continue;
        const section = data as Record<string, unknown>;
        addFromList(map, section.media_urls, `${key}.media_urls`);
        addFromList(map, section.evidence_files, `${key}.evidence_files`);
        addFromList(map, section.formalization_files, `${key}.formalization_files`);
        addFromList(map, section.partner_verification_files, `${key}.partner_verification_files`);
    }

    const attendanceLogs = Array.isArray(report.section1?.attendance_logs)
        ? report.section1.attendance_logs
        : [];
    attendanceLogs.forEach((log, index) => {
        if (!log || typeof log !== 'object') return;
        const entry = log as Record<string, unknown>;
        addCandidate(map, entry.evidence_url, 'section1.attendance_logs', index);
        addCandidate(map, entry.evidence_file, 'section1.attendance_logs', index);
    });

    return Array.from(map.values());
}

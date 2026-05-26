import { collectReportEvidenceFiles } from './collect-report-evidence.util';
import { StudentReport } from './entities/student-report.entity';

describe('collectReportEvidenceFiles', () => {
    it('collects media_urls, section8 files, and attendance evidence', () => {
        const report = {
            id: 'r1',
            section1: {
                media_urls: ['https://bucket.s3.region.amazonaws.com/a.jpg'],
                attendance_logs: [{ evidence_url: 'https://bucket.s3.region.amazonaws.com/b.jpg' }],
            },
            section6: {
                evidence_files: [{ url: 'https://bucket.s3.region.amazonaws.com/c.pdf', name: 'c.pdf' }],
            },
            section8: {
                evidence_files: 'https://bucket.s3.region.amazonaws.com/d.png',
                partner_verification_files: [
                    { url: 'https://bucket.s3.region.amazonaws.com/e.png' },
                ],
            },
        } as unknown as StudentReport;

        const files = collectReportEvidenceFiles(report);
        expect(files).toHaveLength(5);
        expect(files.map((f) => f.url)).toEqual(
            expect.arrayContaining([
                'https://bucket.s3.region.amazonaws.com/a.jpg',
                'https://bucket.s3.region.amazonaws.com/b.jpg',
                'https://bucket.s3.region.amazonaws.com/c.pdf',
                'https://bucket.s3.region.amazonaws.com/d.png',
                'https://bucket.s3.region.amazonaws.com/e.png',
            ]),
        );
    });

    it('deduplicates identical URLs', () => {
        const url = 'https://bucket.s3.region.amazonaws.com/x.jpg';
        const report = {
            section2: { media_urls: [url] },
            section8: { evidence_files: [url] },
        } as unknown as StudentReport;

        expect(collectReportEvidenceFiles(report)).toHaveLength(1);
    });
});

import {
  buildReportPackageNotices,
  relativeAppPath,
} from './review-package.util';
import {
  REPORT_PACKAGE_LOCKED_MESSAGE,
  isReportPackageReleased,
} from './report-package-release.util';
import { sameOriginPath } from '../notifications/notifications.service';

describe('report package release rule', () => {
  it('releases only after CIEL PK Admin approval (admin_status or the verified status)', () => {
    expect(isReportPackageReleased({ admin_status: 'approved' })).toBe(true);
    expect(isReportPackageReleased({ admin_status: 'verified' })).toBe(true);
    expect(isReportPackageReleased({ status: 'verified' })).toBe(true);
    expect(
      isReportPackageReleased({ admin_status: 'pending', status: 'submitted' }),
    ).toBe(false);
    expect(
      isReportPackageReleased({
        faculty_status: 'approved',
        status: 'submitted',
      } as never),
    ).toBe(false);
    expect(isReportPackageReleased(null)).toBe(false);
    expect(REPORT_PACKAGE_LOCKED_MESSAGE).toMatch(/CIEL PK Admin/);
  });
});

describe('in-app package notices', () => {
  const pack = {
    documents: {
      flashcard: {
        title: 'Impact flashcard',
        view: 'flash' as const,
        href: 'https://app.cielpk.com/dashboard/student/report?projectId=p1&view=flash#flash',
      },
    },
    stakeholder_hrefs: {
      student:
        'https://app.cielpk.com/dashboard/student/report?projectId=p1&view=flash#flash',
      faculty:
        'https://app.cielpk.com/dashboard/faculty/reports/r1?view=dossier',
      partner: 'https://app.cielpk.com/dashboard/partner/verify/r1?package=1',
      university:
        'https://app.cielpk.com/dashboard/partner/verify/r1?package=1',
      admin:
        'https://app.cielpk.com/dashboard/admin/reports/verify/r1?package=1',
    },
  } as unknown as Parameters<typeof buildReportPackageNotices>[0];

  it('builds one linked notice per stakeholder, with same-origin links', () => {
    const notices = buildReportPackageNotices(pack, {
      projectTitle: 'Clean water',
      studentName: 'Amina',
    });
    expect(notices.map((n) => n.audience)).toEqual([
      'student',
      'faculty',
      'partner',
      'university',
    ]);
    const byAudience = Object.fromEntries(notices.map((n) => [n.audience, n]));
    expect(byAudience.student.link).toBe(
      '/dashboard/student/report?projectId=p1&view=flash#flash',
    );
    expect(byAudience.faculty.link).toBe(
      '/dashboard/faculty/reports/r1?view=dossier',
    );
    expect(byAudience.partner.link).toBe(
      '/dashboard/partner/verify/r1?package=1',
    );
    expect(byAudience.university.link).toBe(
      '/dashboard/partner/verify/r1?package=1',
    );
    expect(byAudience.student.message).toContain('Clean water');
    expect(byAudience.faculty.message).toContain('Amina');
    for (const n of notices) expect(n.link.startsWith('/')).toBe(true);
  });

  it('relativeAppPath and sameOriginPath never store external or script URLs', () => {
    expect(relativeAppPath('/dashboard/x?y=1')).toBe('/dashboard/x?y=1');
    expect(relativeAppPath('https://app.cielpk.com/a/b?c=1#d')).toBe(
      '/a/b?c=1#d',
    );
    expect(sameOriginPath('https://app.cielpk.com/a/b?c=1#d')).toBe(
      '/a/b?c=1#d',
    );
    expect(sameOriginPath('//evil.example/x')).toBeNull();
    expect(sameOriginPath('javascript:alert(1)')).toBeNull();
    expect(sameOriginPath('')).toBeNull();
    expect(sameOriginPath(undefined)).toBeNull();
  });
});

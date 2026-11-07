import { OpportunitiesService } from './opportunities.service';
import { Opportunity } from './entities/opportunity.entity';
import { OpportunityWorkflowService } from './opportunity-workflow.service';

/**
 * Exhaustive walk of the approval state machine for every creator type.
 *
 * From each freshly-created state we try EVERY reviewer action (faculty / partner / CIEL PK:
 * approve, reject, revise), gated by the SAME predicates the dashboards and token links use, and
 * explore every reachable state (breadth-first). After each step we assert invariants that must
 * hold no matter which order reviewers act in:
 *   - nothing goes live unless every required line has actually approved (no leapfrogging),
 *   - live <=> admin_approved && status active,
 *   - rejected is terminal for every reviewer (nobody can resurrect it),
 *   - a revision-requested listing is closed to reviewers until the creator resubmits.
 */
const workflow = new OpportunityWorkflowService();
const unused = {} as never;
const service = new OpportunitiesService(
  unused,
  unused,
  unused,
  unused,
  unused,
  unused,
  unused,
  unused,
  unused,
  unused,
  unused,
);

type Row = Record<string, unknown>;
type Svc = {
  isAwaitingFacultyDashboardReview(o: Opportunity): boolean;
  isAwaitingPartnerDashboardReview(o: Opportunity): boolean;
  isOpportunityReadyForAdminFinalApprove(o: Opportunity): boolean;
};
const svc = service as unknown as Svc;
const asOpp = (r: Row) => r as unknown as Opportunity;
const actor = { id: 'actor', name: 'Actor' };

type Scenario = { name: string; make: () => Row };

const base = (extra: Row): Row => ({
  id: 'opp-1',
  creatorId: 'creator-1',
  title: 'T',
  version: 1,
  approvalHistory: [],
  admin_approved: false,
  partnerVerified: false,
  execution_verification_token: null,
  execution_verified: false,
  ...extra,
});

const scenarios: Scenario[] = [
  ...[true, false].map((p) => ({
    name: `student, partner=${p}`,
    make: () => {
      const o = base({});
      workflow.initStudentCreated(asOpp(o), p);
      o.partnerVerified = !p;
      return o;
    },
  })),
  ...[true, false].map((p) => ({
    name: `private-candidate student, partner=${p}`,
    make: () => {
      const o = base({});
      workflow.initStudentPrivateCandidate(asOpp(o), p);
      return o;
    },
  })),
  ...[true, false].map((p) => ({
    name: `faculty-authored, partner=${p}`,
    make: () => {
      const o = base({});
      workflow.initFacultyCreated(asOpp(o), p);
      o.partnerVerified = !p;
      return o;
    },
  })),
  ...[
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ].map(([f, p]) => ({
    name: `org-authored, faculty=${f}, partner=${p}`,
    make: () => {
      const o = base({});
      workflow.initOrgCreated(asOpp(o), {
        requiresPartner: p,
        requiresFaculty: f,
        needsExecutingOrg: false,
      });
      o.partnerVerified = !p;
      return o;
    },
  })),
  ...[
    [true, true],
    [true, false],
    [false, true],
  ].map(([f, p]) => ({
    name: `CIEL-admin-authored, faculty=${f}, partner=${p}`,
    make: () => {
      const o = base({});
      workflow.initCielAdminCreated(asOpp(o), {
        requiresPartner: p,
        requiresFaculty: f,
      });
      o.partnerVerified = !p;
      return o;
    },
  })),
];

type Action = {
  name: string;
  enabled(o: Row): boolean;
  apply(o: Row): void;
};

const partnerOpen = (o: Row) =>
  svc.isAwaitingPartnerDashboardReview(asOpp(o)) &&
  (o.isStudentCreated !== true || o.faculty_verified === true);

const actions: Action[] = [
  {
    name: 'faculty approve',
    enabled: (o) => svc.isAwaitingFacultyDashboardReview(asOpp(o)),
    apply: (o) => workflow.afterFacultyVerified(asOpp(o), actor),
  },
  {
    name: 'faculty reject',
    enabled: (o) => svc.isAwaitingFacultyDashboardReview(asOpp(o)),
    apply: (o) => workflow.afterFacultyRejected(asOpp(o), 'no', actor),
  },
  {
    name: 'faculty revise',
    enabled: (o) => svc.isAwaitingFacultyDashboardReview(asOpp(o)),
    apply: (o) => workflow.afterFacultyRevision(asOpp(o), 'fix', actor),
  },
  {
    name: 'partner approve',
    enabled: partnerOpen,
    apply: (o) =>
      o.isStudentCreated
        ? workflow.afterPartnerVerified(asOpp(o), actor)
        : workflow.afterFacultyCreatedPartnerVerified(asOpp(o), actor),
  },
  {
    name: 'partner reject',
    enabled: partnerOpen,
    apply: (o) => workflow.afterPartnerRejected(asOpp(o), 'no', actor),
  },
  {
    name: 'partner revise',
    enabled: partnerOpen,
    apply: (o) => workflow.afterPartnerRevision(asOpp(o), 'fix', actor),
  },
  {
    name: 'CIEL PK approve',
    enabled: (o) => svc.isOpportunityReadyForAdminFinalApprove(asOpp(o)),
    apply: (o) => workflow.afterAdminApproved(asOpp(o), actor),
  },
  {
    // service.reject(): only a no-op once already rejected.
    name: 'CIEL PK reject',
    enabled: (o) => o.workflowStage !== 'rejected',
    apply: (o) => workflow.afterAdminRejected(asOpp(o), 'no', actor),
  },
  {
    // service.revise(): refused once permanently rejected.
    name: 'CIEL PK revise',
    enabled: (o) => o.workflowStage !== 'rejected',
    apply: (o) => workflow.afterAdminRevision(asOpp(o), 'fix', actor),
  },
];

const OK_LINE = ['approved', 'not_applicable', 'not_required'];

function key(o: Row) {
  return JSON.stringify([
    o.workflowStage,
    o.status,
    o.facultyApprovalStatus,
    o.partnerApprovalStatus,
    o.adminApprovalStatus,
    o.admin_approved,
    o.faculty_verified,
    o.partnerVerified,
  ]);
}

function violations(o: Row, path: string[]): string[] {
  const where = `[${path.join(' > ') || 'created'}]`;
  const v: string[] = [];
  const live = o.workflowStage === 'live';
  if (live && !(o.admin_approved === true && o.status === 'active')) {
    v.push(`${where} live stage but admin_approved/status inconsistent`);
  }
  if (o.admin_approved === true && !live) {
    v.push(
      `${where} admin_approved=true while stage is ${String(o.workflowStage)}`,
    );
  }
  if (live) {
    if (!OK_LINE.includes(String(o.facultyApprovalStatus))) {
      v.push(
        `${where} LIVE with faculty line ${String(o.facultyApprovalStatus)}`,
      );
    }
    if (
      o.requiresPartnerApproval === true &&
      o.partnerApprovalStatus !== 'approved'
    ) {
      v.push(
        `${where} LIVE with partner line ${String(o.partnerApprovalStatus)}`,
      );
    }
  }
  if (o.workflowStage === 'rejected') {
    for (const a of actions) {
      if (a.name === 'CIEL PK reject' || a.name === 'CIEL PK revise') continue;
      if (a.enabled(o))
        v.push(`${where} REJECTED listing still allows "${a.name}"`);
    }
  }
  if (o.workflowStage === 'revision') {
    for (const a of actions) {
      if (a.name.startsWith('CIEL PK')) {
        if (a.name === 'CIEL PK approve' && a.enabled(o)) {
          v.push(`${where} REVISION listing still allows "CIEL PK approve"`);
        }
        continue;
      }
      if (a.enabled(o))
        v.push(`${where} REVISION listing still allows "${a.name}"`);
    }
  }
  const pairs: Array<[unknown, string]> = [
    ['pending_admin', 'pending_approval'],
    ['pending_partner', 'pending_partner'],
    ['pending_faculty', 'pending_faculty'],
    ['rejected', 'rejected'],
    ['revision', 'revision'],
    ['live', 'active'],
  ];
  for (const [stage, status] of pairs) {
    if (o.workflowStage === stage && o.status !== status) {
      v.push(`${where} stage ${String(stage)} but status ${String(o.status)}`);
    }
  }
  return v;
}

describe('approval lifecycle — every reachable state, every reviewer order', () => {
  it.each(scenarios.map((s) => [s.name, s] as const))(
    '%s',
    (_name, scenario) => {
      const seen = new Set<string>();
      const problems: string[] = [];
      let reachedLive = false;
      const queue: Array<{ row: Row; path: string[] }> = [
        { row: scenario.make(), path: [] },
      ];
      while (queue.length) {
        const { row, path } = queue.shift()!;
        const k = key(row);
        if (seen.has(k)) continue;
        seen.add(k);
        problems.push(...violations(row, path));
        if (row.workflowStage === 'live') reachedLive = true;
        if (path.length >= 7) continue;
        for (const a of actions) {
          if (!a.enabled(row)) continue;
          const next = JSON.parse(JSON.stringify(row)) as Row;
          a.apply(next);
          queue.push({ row: next, path: [...path, a.name] });
        }
      }
      expect(problems).toEqual([]);
      // Sanity: the happy path must actually be reachable (no accidental dead end).
      expect(reachedLive).toBe(true);
      expect(seen.size).toBeGreaterThan(1);
    },
  );
});

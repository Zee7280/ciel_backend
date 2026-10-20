import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import { AdminTeamSnapshot } from './entities/admin-team-snapshot.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { StudentReport } from '../reports/entities/student-report.entity';
import { Payment } from '../payments/entities/payment.entity';
import { OpportunityApplication } from './entities/opportunity-application.entity';

export type SnapshotActor = { id?: string | null; email?: string | null };

/** Entities → plain JSON (dates become ISO strings, relations are not loaded so none are copied). */
export function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function saveSnapshot(
  em: EntityManager,
  input: {
    opportunityId: string;
    kind: AdminTeamSnapshot['kind'];
    label: string;
    actor?: SnapshotActor;
    summary: Record<string, number>;
    payload: Record<string, unknown>;
  },
): Promise<AdminTeamSnapshot> {
  const repo = em.getRepository(AdminTeamSnapshot);
  return repo.save(
    repo.create({
      opportunityId: input.opportunityId,
      kind: input.kind,
      label: input.label.slice(0, 300),
      actorId: input.actor?.id ?? null,
      actorEmail: input.actor?.email ?? null,
      summary: input.summary,
      payload: input.payload,
      restoredAt: null,
      restoredBy: null,
    }),
  );
}

type DeletePayload = {
  participations: Record<string, unknown>[];
  reports: Record<string, unknown>[];
  payments: Record<string, unknown>[];
  withdrawnApplicationIds: string[];
  /** Member delete only: the seat promoted to lead because the lead was removed. */
  promotedParticipationId?: string | null;
};

type MergePayload = {
  before: Array<{
    id: string;
    teamId: string | null;
    participationMode: string | null;
    isTeamLead: boolean;
    teamDisplayName: string | null;
    formationSource: string | null;
    applicationId: string | null;
  }>;
  demotedLeadIds: string[];
  deletedReports: Record<string, unknown>[];
  reassigned: { reportId: string; fromStudentId: string } | null;
};

/**
 * Undo a snapshot. Refuses (without changing anything) when the roster moved on in a way that
 * would collide with the restored rows, so an undo can never create duplicate seats.
 */
export async function restoreSnapshot(
  em: EntityManager,
  snapshotId: string,
  opportunityId: string,
  actor?: SnapshotActor,
): Promise<{ kind: string; restored: Record<string, number> }> {
  const snap = await em.getRepository(AdminTeamSnapshot).findOne({
    where: { id: snapshotId, opportunityId },
  });
  if (!snap)
    throw new NotFoundException('Snapshot not found for this opportunity');
  if (snap.restoredAt) {
    throw new BadRequestException('This change was already undone.');
  }

  const restored: Record<string, number> = {};

  if (snap.kind === 'delete_team' || snap.kind === 'delete_member') {
    const p = snap.payload as unknown as DeletePayload;
    const partRepo = em.getRepository(Participation);

    const ids = p.participations.map((r) => String(r.id));
    if (ids.length && (await partRepo.count({ where: { id: In(ids) } })) > 0) {
      throw new BadRequestException(
        'Some of these seats already exist again. Nothing was restored.',
      );
    }
    const studentIds = p.participations
      .map((r) => (typeof r.studentId === 'string' ? r.studentId : ''))
      .filter(Boolean);
    if (studentIds.length) {
      const clash = await partRepo.find({
        where: { projectId: opportunityId, studentId: In(studentIds) },
        select: ['id', 'fullName', 'studentId'],
      });
      if (clash.length) {
        throw new BadRequestException(
          `${clash.map((c) => c.fullName || c.studentId).join(', ')} already ${clash.length === 1 ? 'has' : 'have'} a new enrollment on this project, so these seats cannot be restored. Remove that enrollment first.`,
        );
      }
    }

    await partRepo.save(partRepo.create(p.participations as never[]));
    restored.participations = p.participations.length;

    if (p.reports.length) {
      const repRepo = em.getRepository(StudentReport);
      const existing = new Set(
        (
          await repRepo.find({
            where: { id: In(p.reports.map((r) => String(r.id))) },
            select: ['id'],
          })
        ).map((r) => r.id),
      );
      const toInsert = p.reports.filter((r) => !existing.has(String(r.id)));
      if (toInsert.length)
        await repRepo.save(repRepo.create(toInsert as never[]));
      restored.reports = toInsert.length;
    }
    if (p.payments.length) {
      const payRepo = em.getRepository(Payment);
      const existing = new Set(
        (
          await payRepo.find({
            where: { id: In(p.payments.map((r) => String(r.id))) },
            select: ['id'],
          })
        ).map((r) => r.id),
      );
      const toInsert = p.payments.filter((r) => !existing.has(String(r.id)));
      if (toInsert.length)
        await payRepo.save(payRepo.create(toInsert as never[]));
      restored.payments = toInsert.length;
    }
    if (p.withdrawnApplicationIds.length) {
      await em
        .getRepository(OpportunityApplication)
        .createQueryBuilder()
        .update(OpportunityApplication)
        .set({ withdrawnAt: null })
        .where('id IN (:...ids)', { ids: p.withdrawnApplicationIds })
        .execute();
      restored.applications = p.withdrawnApplicationIds.length;
    }
    if (p.promotedParticipationId) {
      const restoredLeads = p.participations.filter(
        (r) => r.isTeamLead === true,
      );
      if (restoredLeads.length) {
        await partRepo.update(p.promotedParticipationId, { isTeamLead: false });
      }
    }
  } else if (
    snap.kind === 'merge' ||
    snap.kind === 'move_member' ||
    snap.kind === 'split_member' ||
    snap.kind === 'set_lead'
  ) {
    const p = snap.payload as unknown as MergePayload;
    const partRepo = em.getRepository(Participation);
    for (const b of p.before) {
      await partRepo.update(b.id, {
        teamId: b.teamId as never,
        participationMode: b.participationMode as never,
        isTeamLead: b.isTeamLead,
        teamDisplayName: b.teamDisplayName as never,
        formationSource: b.formationSource as never,
        applicationId: b.applicationId as never,
      });
    }
    restored.participations = p.before.length;
    if (p.demotedLeadIds.length) {
      await partRepo.update({ id: In(p.demotedLeadIds) }, { isTeamLead: true });
    }
    const repRepo = em.getRepository(StudentReport);
    if (p.reassigned) {
      await repRepo.update(p.reassigned.reportId, {
        studentId: p.reassigned.fromStudentId,
      });
      restored.reports = (restored.reports ?? 0) + 1;
    }
    if (p.deletedReports.length) {
      const existing = new Set(
        (
          await repRepo.find({
            where: { id: In(p.deletedReports.map((r) => String(r.id))) },
            select: ['id'],
          })
        ).map((r) => r.id),
      );
      const toInsert = p.deletedReports.filter(
        (r) => !existing.has(String(r.id)),
      );
      if (toInsert.length)
        await repRepo.save(repRepo.create(toInsert as never[]));
      restored.reports = (restored.reports ?? 0) + toInsert.length;
    }
  } else {
    throw new BadRequestException('Unknown snapshot type.');
  }

  snap.restoredAt = new Date();
  snap.restoredBy = actor?.email ?? actor?.id ?? null;
  await em.getRepository(AdminTeamSnapshot).save(snap);
  return { kind: snap.kind, restored };
}

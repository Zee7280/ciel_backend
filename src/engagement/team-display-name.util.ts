import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { Participation } from './entities/participant.entity';

function trimTitle(value: unknown, maxLen: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return 'Project';
  return text.length <= maxLen ? text : `${text.slice(0, maxLen - 1).trim()}…`;
}

function leadFirstName(row: Participation | null | undefined): string {
  if (!row) return 'Team';
  const raw = (row.fullName || row.student?.name || '').trim();
  if (!raw) return 'Team';
  return raw.split(/\s+/)[0] || 'Team';
}

/** `{Project title} · {Lead} Team` or `{Project} · Team {n} ({Lead})` when sequence > 1. */
export function buildTeamDisplayName(
  opportunity: Pick<Opportunity, 'title'> | null | undefined,
  lead: Participation | null | undefined,
  teamSequence = 1,
): string {
  const project = trimTitle(opportunity?.title, 60);
  const leadName = leadFirstName(lead);
  if (teamSequence <= 1) {
    return `${project} · ${leadName} Team`;
  }
  return `${project} · Team ${teamSequence} (${leadName})`;
}

export function countDistinctTeamIdsOnProject(rows: Participation[]): number {
  const ids = new Set<string>();
  for (const row of rows) {
    const tid = (row.teamId || '').trim();
    if (tid) ids.add(tid);
  }
  return ids.size;
}

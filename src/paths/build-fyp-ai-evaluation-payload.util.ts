import { FypEntry } from './entities/fyp-entry.entity';

export const FYP_AI_EVALUATION_SCHEMA_VERSION = 'fyp_ai_evaluation_v1.0';

type UnknownRecord = Record<string, unknown>;

export interface FypAiEvaluationPayload {
  schema_version: typeof FYP_AI_EVALUATION_SCHEMA_VERSION;
  generated_at: string;
  submission_metadata: UnknownRecord;
  project_info: UnknownRecord;
  background: UnknownRecord;
  objectives: UnknownRecord;
  literature: UnknownRecord;
  methodology: UnknownRecord;
  findings: UnknownRecord;
  route_details: UnknownRecord;
  sdg_mapping: UnknownRecord;
  reflection: UnknownRecord;
  repository: UnknownRecord;
  section_summaries: UnknownRecord;
  system_validation: UnknownRecord;
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

/**
 * Builds the CIEL PK FYP AI Evaluator payload from a submitted FypEntry. Excludes team members'
 * contact details (WhatsApp numbers) that carry no evaluative signal — same "strip what the model
 * doesn't need" rule as buildCielPkAiEvaluationPayload applies for Community Service reports.
 */
export function buildFypAiEvaluationPayload(entry: FypEntry): FypAiEvaluationPayload {
  const projectInfo = asRecord(entry.projectInfo);
  const teamMembers = Array.isArray(projectInfo.teamMembers)
    ? (projectInfo.teamMembers as unknown[]).map((m) => {
        if (typeof m === 'string') return { name: m };
        const row = asRecord(m);
        return {
          name: row.name,
          role: row.role,
          rollNumber: row.rollNumber,
        };
      })
    : [];

  return {
    schema_version: FYP_AI_EVALUATION_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    submission_metadata: {
      entry_id: entry.id,
      project_title: entry.projectTitle || projectInfo.title,
      university: projectInfo.university,
      school: projectInfo.school,
      degree: projectInfo.degree,
      discipline: projectInfo.discipline || projectInfo.academicArea,
      academic_level: projectInfo.academicLevel,
      team_type: projectInfo.teamType,
      project_types: projectInfo.projectTypes || projectInfo.projectType,
      lead_route: projectInfo.leadRoute,
      team_members: teamMembers,
      submitted_status: entry.status,
    },
    project_info: {
      title: entry.projectTitle || projectInfo.title,
      overview: entry.overview,
    },
    background: asRecord(entry.background),
    objectives: asRecord(entry.objectivesInfo),
    literature: asRecord(entry.literature),
    methodology: asRecord(entry.methodology),
    findings: asRecord(entry.findings),
    route_details: asRecord(entry.routeDetails),
    sdg_mapping: asRecord(entry.sdgMapping),
    reflection: asRecord(entry.reflectionInfo),
    repository: asRecord(entry.repository),
    section_summaries: asRecord(entry.sectionSummaries),
    system_validation: {
      sensitive_fields_removed: true,
      has_section_summaries: Object.keys(asRecord(entry.sectionSummaries)).length > 0,
    },
  };
}

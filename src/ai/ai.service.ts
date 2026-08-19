import { HttpException, Injectable } from '@nestjs/common';
import {
  buildSection11EvaluationUserMessage,
  buildSection11MasterRubricUserMessage,
} from './build-section11-evaluation-user-message.util';
import {
  SECTION11_MASTER_RUBRIC_EVALUATOR_PROMPT,
  SECTION11_MASTER_RUBRIC_JSON_ONLY_DEPLOYMENT_NOTE,
} from './prompts/section11-master-rubric-prompt.constants';
import {
  SECTION11_EVALUATOR_PROMPT,
  SECTION11_JSON_ONLY_DEPLOYMENT_NOTE,
} from './prompts/section11-prompt.constants';
import { parseSection11AuditSummary } from './parse-cii-audit-summary.util';
import { parseSection11V61Response } from './parse-section11-v61.util';
import { parseSection11V81Response } from './parse-section11-v81.util';

type OpenAiCompletionOpts = {
  temperature?: number;
  /** When set, requests reproducible sampling (same inputs → same text for supported models). */
  seed?: number;
  maxTokens?: number;
  responseFormat?: { type: 'json_object' };
  systemMessage?: string;
};

export interface AiSummarizeResult {
  summary: string;
  auditMeta?: unknown;
  evaluationVersion?: string;
}

function isOpenAiReasoningModel(model: string): boolean {
  const m = model.toLowerCase();
  return (
    m.startsWith('gpt-5') ||
    m.startsWith('o1') ||
    m.startsWith('o3') ||
    m.startsWith('o4') ||
    m.includes('gpt-5.')
  );
}

function resolveOpenAiErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return 'Failed to generate AI response';
}

@Injectable()
export class AiService {
  private async generateSummaryWithOpenAI(
    userPrompt: string,
    opts?: OpenAiCompletionOpts,
  ): Promise<string> {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY missing');
    }

    const model = process.env.OPENAI_SUMMARY_MODEL?.trim() || 'gpt-5.4';
    const reasoningModel = isOpenAiReasoningModel(model);

    const temperature = opts?.temperature ?? 0.4;
    const requestBody: Record<string, unknown> = {
      model,
      messages: [
        {
          role: 'system',
          content:
            opts?.systemMessage ||
            'You are ChatGPT, acting as a precise institutional impact analyst. Follow instructions exactly. Output plain text only unless a specific format is requested.',
        },
        { role: 'user', content: userPrompt },
      ],
    };

    if (!reasoningModel) {
      requestBody.temperature = temperature;
      if (opts?.seed !== undefined) {
        requestBody.seed = opts.seed;
      }
    }

    if (opts?.maxTokens !== undefined) {
      if (reasoningModel) {
        requestBody.max_completion_tokens = opts.maxTokens;
      } else {
        requestBody.max_tokens = opts.maxTokens;
      }
    }
    if (opts?.responseFormat) {
      requestBody.response_format = opts.responseFormat;
    }

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    const responseJson = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
      error?: { message?: string };
    };

    if (!res.ok) {
      const err = new Error(
        responseJson.error?.message || `OpenAI error (${res.status})`,
      ) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }

    const text = responseJson.choices?.[0]?.message?.content?.trim();
    if (!text) {
      throw new Error('OpenAI returned empty content');
    }

    return text;
  }

  private buildPrompt(section: string, data: any): string {
    switch (section) {
      // =====================================================
      // SECTION 1 EVALUATION
      // =====================================================
      case 'section1_evaluation':
        return `You are an AI Evaluation Assistant for the CIEL PK Community Engagement Reporting System.

Evaluate Section 1 — PARTICIPATION, IDENTITY & ATTENDANCE INTEGRITY and calculate the Composite Impact Index (CII) score.

INPUTS:
Data: ${JSON.stringify(data)}

SECTION 1 — PARTICIPATION, IDENTITY & ATTENDANCE INTEGRITY

Total Weight = 20 Marks

This section evaluates:
- Correct student identification details
- Accurate academic information
- Proper team/project linkage
- Attendance consistency
- Hour completion against project-defined required hours
- Participation authenticity
- Logical engagement in project activities
- Attendance log quality and realism

IMPORTANT EVALUATION PRINCIPLE:
"Verify reasonably, penalize carefully."

Your purpose is NOT to aggressively reject participation or penalize collaborative work unnecessarily. Community engagement is often team-based, and students may participate together in groups.

Students may work:
- Individually
- In teams/groups

Teams may consist of:
- Minimum 2 students
- Maximum 20 students

It is completely normal for:
- Multiple students to attend together
- Teams to log similar timings
- Students to upload similar evidence
- Entire groups to participate simultaneously
- Similar activities to be reported by team members

DO NOT automatically treat group participation as suspicious.

Large group attendance is common and operationally normal in community engagement activities.

------------------------------------------------
PROJECT HOURS RULE
------------------------------------------------

Each project defines its own required minimum hours.

16 hours may commonly be used but it is NOT universal.

You MUST evaluate attendance according to:
- Project-defined required hours per student
- Nature of activity
- Team structure
- Timeline
- Scope of work
- Approved project objectives

Never penalize students simply because:
- Many students attended together
- Hours overlap across teams
- Participation is collaborative
- Evidence/photos are shared
- Activity descriptions are similar

------------------------------------------------
SECTION 1 SCORING FORMULA
------------------------------------------------

Section 1 CII Score:

S1 = S1_base + B

Where:

S1_base = base participation score out of 15

B = bonus for extra hours out of 5

Final score must not exceed 20.

S1 = min(20, S1_base + B)

------------------------------------------------
BASE FORMULA
------------------------------------------------

S1_base = 15 × (0.10*I + 0.10*A + 0.35*H + 0.20*F + 0.15*C + 0.10*L)

Where:

I = Identity Completeness Score
A = Academic / Team Setup Completeness Score
H = Individual Hours Compliance Score
F = Visit Frequency Score
C = Continuity / Spread Score
L = Attendance Log Quality Score

All component scores must be between 0 and 1.

------------------------------------------------
1) IDENTITY COMPLETENESS SCORE (I)
------------------------------------------------

Check whether the student's identity and verification fields are complete enough for auditability.

Evaluate:
- Full name
- Student ID / registration number
- Email
- Contact information, if required
- University / institution link
- Consistency between student identity and participation records

Scoring rule:

1.00 = all required identity fields complete and verified
0.75 = fields complete but one minor verification item missing
0.50 = partial identity information but still identifiable
0.25 = major identity gaps or unclear student identity
0.00 = unusable / unverifiable identity

Important:
Minor spelling mistakes, formatting issues, or small clerical errors should not be harshly penalized unless they create serious identity inconsistency.

------------------------------------------------
2) ACADEMIC / TEAM SETUP COMPLETENESS SCORE (A)
------------------------------------------------

Check whether the student is properly linked to the academic and team structure of the project.

Evaluate:
- Degree/program
- Department
- Course, if applicable
- Faculty supervisor, if applicable
- Team name / team members, if applicable
- Project name
- Role in team/project
- Correct linkage to approved opportunity

Scoring rule:

1.00 = all core academic and team fields complete
0.75 = minor missing information
0.50 = several missing fields but project linkage is still understandable
0.25 = weak/incomplete academic or team linkage
0.00 = no meaningful academic/team setup

Important:
Do not penalize students simply because they are part of a large team. Teams of up to 20 students are allowed where project design supports it.

------------------------------------------------
3) INDIVIDUAL HOURS COMPLIANCE SCORE (H)
------------------------------------------------

Evaluate whether the individual student completed the required minimum hours defined by the project.

Formula:

H = min(IH_i / RHS, 1)

Where:

IH_i = individual student hours completed
RHS = required hours per student defined by the project

Important:
- Use the project-defined required hours.
- Do NOT assume 16 hours unless the project states 16 hours.
- Each individual student must meet their own required hours.
- Group hours do not replace individual hours.
- If a team has 10 students and the project requires 16 hours per student, each student must complete 16 hours individually.

Scoring logic:

1.00 = student meets or exceeds required hours
0.75 = student completes around 75% of required hours
0.50 = student completes around 50% of required hours
0.25 = student completes around 25% of required hours
0.00 = no meaningful hours logged

------------------------------------------------
4) VISIT FREQUENCY SCORE (F)
------------------------------------------------

Evaluate whether the number of visits/sessions is reasonable according to the required hours.

Formula:

V_exp = max(2, ceiling(RHS / 8))

F = min(V_i / V_exp, 1)

Where:

V_i = actual number of visits or attendance entries
V_exp = expected number of visits

Interpretation:
- A student completing 16 hours would normally be expected to have at least 2 visits.
- A student completing longer projects may reasonably need more visits.
- However, some projects may involve long single-day or event-based engagement. In such cases, evaluate contextually.

Important:
Do not penalize repeated visits if they are logical.
Do not penalize shared visit dates/times in team-based work.

------------------------------------------------
5) CONTINUITY / SPREAD SCORE (C)
------------------------------------------------

Evaluate whether the attendance is reasonably spread across the project timeline.

Formula:

D_span = days between first and last attendance + 1

D_exp = max(2, ceiling(V_exp * 1.5))

C = min(D_span / D_exp, 1)

Interpretation:
- A better spread usually indicates more consistent engagement.
- However, some projects are designed as short events, drives, workshops, or 1–2 day field activities.
- If the project timeline itself is short, do not unfairly penalize the student for limited spread.

Important:
Evaluate continuity according to the approved project duration and nature of activity.

------------------------------------------------
6) ATTENDANCE LOG QUALITY SCORE (L)
------------------------------------------------

Evaluate the quality, specificity, and realism of attendance logs.

Formula:

L = 0.20*Q_d + 0.20*Q_t + 0.20*Q_p + 0.20*Q_a + 0.20*Q_r

Each sub-component is scored from 0 to 1.

Q_d = Date Quality
1 = date is properly recorded
0.5 = date is partially unclear
0 = date is missing or unusable

Q_t = Time / Duration Quality
1 = duration or start-end time is properly recorded
0.5 = partial time/duration information
0 = no usable time/duration

Q_p = Partner / Location Clarity
1 = partner/location is clearly identified
0.5 = partner/location partially clear
0 = partner/location missing or unclear

Q_a = Activity Description Quality
1 = work description is specific and meaningful
0.5 = description is general but understandable
0 = description is vague, e.g., "worked," "present," "did activity"

Q_r = Realism / Authenticity of Logs
1 = logs appear realistic and coherent
0.5 = minor repetition or limited detail but still plausible
0 = logs appear fake, copied without logic, contradictory, or impossible

Important:
Do NOT automatically penalize:
- Similar descriptions in group work
- Shared timings
- Shared photos/evidence
- Similar activities among team members

Only reduce Q_r where there is strong evidence of fabrication, contradiction, or unrealistic reporting.

------------------------------------------------
7) BONUS FOR EXTRA HOURS (B)
------------------------------------------------

Award bonus only if the student exceeds the project-defined required hours.

Formula:

If IH_i > RHS:

B = min(5, 5 × (IH_i - RHS) / RHS)

If IH_i <= RHS:

B = 0

Important:
- Bonus rewards extra verified/logical hours.
- Extra hours must still appear realistic and aligned with project activities.
- Do not award bonus for exaggerated, unsupported, or impossible hours.
- Final Section 1 score must not exceed 20.

------------------------------------------------
RED FLAGS
------------------------------------------------

Only raise red flags where there is strong evidence of inconsistency, fabrication, or serious weakness.

Possible red flags include:

1. Identity or academic inconsistency:
- Mismatched student details
- Contradictory academic records
- Missing essential identification information
- Identity details inconsistent with participation records

2. Unrealistic hour claims:
- Impossible schedules
- Excessive unsupported hours
- Contradictory timings
- Same student appearing in conflicting places/times

3. Completely vague attendance:
Examples:
- "Worked"
- "Present"
- "Did activity"

without meaningful explanation.

4. Suspicious or fabricated reporting:
- Contradictory entries
- Impossible participation patterns
- Repeated false logs
- Clearly manipulated attendance

5. Misalignment:
- Activities unrelated to approved project objectives
- Reported participation does not match project scope

Do NOT raise red flags merely because:
- Many students attended together
- A team logged the same date/time
- Evidence is shared
- Descriptions are similar but still logical
- The project involved a large group

------------------------------------------------
QUALITY LEVEL
------------------------------------------------

Assign a quality level based on the final Section 1 CII score:

18–20 = Exceptional
15–17.99 = Strong
12–14.99 = Good
8–11.99 = Basic
0–7.99 = Poor

------------------------------------------------
RECOMMENDED ACTION OPTIONS
------------------------------------------------

Use ONLY one of the following:

- Fully Accepted
- Accepted with Observation
- Revision Requested
- Partial Deduction Recommended
- Major Deduction Recommended
- Escalate for Manual Review

Guidance:

Fully Accepted:
Use when participation is complete, logical, and well supported.

Accepted with Observation:
Use when minor gaps exist but participation appears valid.

Revision Requested:
Use when clarification or missing information is needed before final approval.

Partial Deduction Recommended:
Use when there are moderate issues but participation is still partly valid.

Major Deduction Recommended:
Use when serious gaps, weak justification, or major inconsistencies exist.

Escalate for Manual Review:
Use only when there is strong suspicion of fabrication, identity mismatch, impossible attendance, or serious contradiction.

------------------------------------------------
OUTPUT FORMAT
------------------------------------------------

For EACH student, return:

Student Name: ___
Project Name: ___
Team Size: ___
Required Hours Per Student (RHS): ___
Total Logged Individual Hours (IH_i): ___

Identity Completeness (I): ___
Academic / Team Setup (A): ___
Individual Hours Compliance (H): ___
Visit Frequency (F): ___
Continuity / Spread (C): ___
Attendance Log Quality (L): ___
Bonus (B): ___

Section 1 CII Score: ___ / 20
Quality Level: Poor / Basic / Good / Strong / Exceptional

Evaluation Summary:
Write 80–120 words explaining why the score was assigned. Mention identity accuracy, attendance logic, hour completion, participation justification, team context, and any concerns.

Strengths:
- ___
- ___
- ___

Weaknesses:
- ___
- ___

Red Flags:
- ___
If there are no red flags, write: No major red flags identified.

Recommended Action:
Choose only one:
Fully Accepted / Accepted with Observation / Revision Requested / Partial Deduction Recommended / Major Deduction Recommended / Escalate for Manual Review

------------------------------------------------
FINAL REVIEW PRINCIPLES
------------------------------------------------

1. Community engagement is collaborative by nature.
2. Large team participation is normal.
3. Shared evidence is acceptable in team-based activities.
4. Similar timings are normal when students work together.
5. Logical participation matters more than excessive evidence.
6. Penalize only where there is genuine inconsistency, weak justification, or fabrication.
7. Use project-defined hours, not a fixed 16-hour assumption.
8. Read all attendance entries carefully before evaluating.
9. Be fair, contextual, and intelligent.
10. Support authentic student participation while identifying genuinely problematic submissions.`;

      // =====================================================
      // SECTION 2 AUTO SUMMARY
      // =====================================================
      case 'section2':
        return `You are a professional institutional impact analyst. Generate a structured baseline summary based on the following student project information.

                Inputs:
                - Project Title: ${data.projectTitle}
                - Partner Organization: ${data.partnerOrg}
                - Location: ${data.location}
                - Project Duration: ${data.duration}
                - Problem / System Need: ${data.problem_statement}
                - Academic Discipline: ${data.discipline}
                - Discipline Contribution: ${data.discipline_contribution}
                - Baseline Evidence Sources: ${data.baseline_evidence} ${data.baseline_evidence_other ? `(${data.baseline_evidence_other})` : ''}

                Generate a summary with exactly these 5 numbered sections:
                1. Identified Problem: Clearly describe the issue or system gap that existed before the intervention.
                2. Affected Beneficiary Group: Identify who was affected and where.
                3. Baseline Evidence: Explain what data or sources informed the understanding of the problem.
                4. Academic Perspective: Explain how the student's academic discipline helped analyze the situation.
                5. Intervention Justification: Explain why a structured intervention was necessary.

                Constraints:
                - Limit the entire summary to 120–150 words.
                - Use professional institutional language.
                - Do not describe activities, results, or outcomes.
                - Focus strictly on the baseline context.
                - Do NOT use markdown formatting (no bolding, no asterisks). Output plain text only.`;

      // =====================================================
      // SECTION 2 EVALUATION
      // =====================================================
      case 'section2_evaluation':
        return `Evaluate Section 2 — PROJECT CONTEXT & BASELINE UNDERSTANDING and calculate the Composite Impact Index (CII) score.

INPUTS:
Data: ${JSON.stringify(data)}

SECTION 2 — PROJECT CONTEXT & BASELINE UNDERSTANDING
Weight = 10
S2=10×(0.35*P + 0.25*B + 0.20*E + 0.20*D)

Where:
P = problem clarity
B = baseline specificity
E = evidence/source credibility
D = discipline linkage

1) Problem Clarity Score (P):
P = 0.25*P1 + 0.20*P2 + 0.15*P3 + 0.20*P4 + 0.20*P5
P1 = 1 if the core issue is clearly defined
P2 = 1 if the affected population is clearly named
P3 = 1 if the setting/community is clearly identified
P4 = 1 if the student explains why the issue matters
P5 = 1 if the problem is focused and concrete rather than vague

2) Baseline Specificity Score (B):
B = 0.25*B1 + 0.25*B2 + 0.20*B3 + 0.15*B4 + 0.15*B5
B1 = 1 if pre-project condition is clearly described
B2 = 1 if description is specific
B3 = 1 if baseline is logically tied to the stated problem
B4 = 1 if some indicator/observation/metric is given
B5 = 1 if baseline looks credible and relevant

3) Evidence / Source Credibility Score (E):
E = 0.20*E1 + 0.25*E2 + 0.25*E3 + 0.15*E4 + 0.15*E5
E1 = 1 if a source is actually cited or referenced
E2 = 1 if source directly supports the problem/baseline
E3 = 1 if source is credible
E4 = 1 if source is concrete rather than generic
E5 = 1 if source is appropriate for the context

4) Discipline Linkage Score (D):
D = 0.20*D1 + 0.25*D2 + 0.20*D3 + 0.20*D4 + 0.15*D5
D1 = 1 if department/discipline is explicitly identified
D2 = 1 if project linkage is clearly explained
D3 = 1 if student shows actual use of discipline-based knowledge
D4 = 1 if the linkage is relevant and not forced
D5 = 1 if the student explains what role the discipline played in action

OUTPUT FORMAT
Return:
Problem Clarity (P) = ___
Baseline Specificity (B) = ___
Evidence Credibility (E) = ___
Discipline Linkage (D) = ___

Section 2 CII Score = ___ / 10
Provide a brief explanation of the score.`;

      // =====================================================
      // SECTION 3 AUTO SUMMARY
      // =====================================================
      case 'section3':
        return `You are a student writing a formal community service report. Summarize the SDG contribution intent.
                Focus on your INTENT and PLAN to address the goal.
                Strictly write in the first person ('I' or 'We'). Write exactly 2 concise sentences.
                Do NOT use any markdown formatting, asterisks, or bullet points. Output plain text only.

                Primary SDG: ${data.primary_sdg?.goal_title}
                Intent Statement: ${data.contribution_intent_statement}`;

      // =====================================================
      // SECTION 3 EVALUATION
      // =====================================================
      case 'section3_evaluation':
        return `Evaluate Section 3 — SDG CONTRIBUTION MAPPING and calculate the Composite Impact Index (CII) score.

INPUTS:
Data: ${JSON.stringify(data)}

SECTION 3 — SDG CONTRIBUTION MAPPING
Weight = 10
Final Section 3 Formula
S3=S3_base+S3_bonus

Base score
S3_base=9×(0.40*M + 0.25*T + 0.20*I + 0.15*J)

Bonus for optional secondary SDGs
S3_bonus=min(1, B_1 + B_2)

For each optional secondary SDG:
B_k=0.5×(0.50*R_k + 0.50*J_k)

M = SDG match accuracy
M = 0.25*M1 + 0.20*M2 + 0.20*M3 + 0.20*M4 + 0.15*M5
(M1: problem-to-SDG fit, M2: activity-to-SDG fit, M3: outcome-to-SDG fit, M4: primacy of SDG, M5: absence of contradiction)

T = target alignment quality
T = 0.20*T1 + 0.25*T2 + 0.20*T3 + 0.20*T4 + 0.15*T5
(T1: belongs to SDG, T2: matches purpose, T3: matches activities, T4: matches outcomes, T5: specificity)

I = indicator relevance
I = 0.20*I1 + 0.25*I2 + 0.25*I3 + 0.15*I4 + 0.15*I5

J = justification strength
J = 0.20*J1 + 0.20*J2 + 0.20*J3 + 0.20*J4 + 0.20*J5

R_k = relevance of secondary SDG
R_k = 0.30*R1_k + 0.25*R2_k + 0.25*R3_k + 0.20*R4_k

J_k = justification quality of secondary SDG
J_k = 0.30*K1_k + 0.25*K2_k + 0.25*K3_k + 0.20*K4_k

Calculate everything with values from 0 to 1 for subparts.
OUTPUT FORMAT
Return:
SDG Match (M) = ___
Target Alignment (T) = ___
Indicator Relevance (I) = ___
Justification (J) = ___
Secondary Bonus (S3_bonus) = ___

Section 3 CII Score = ___ / 10
Provide a brief explanation of the score.`;

      // =====================================================
      // SECTION 4 AUTO SUMMARY
      // =====================================================
      case 'section4':
        return `You are a professional institutional analyst. Generate a structured report summary for Section 4 (Activities & Outputs) based on the project data.

                Strictly follow these three steps:
                1. Implementation Profile: Describe what activities were conducted, the delivery mode, total sessions, and overall duration. Identify the dominant activity cluster if multiple types exist.
                2. Output Profile: Summarize the outputs delivered, their diversity, and scale. Analyze "Other" output types and classify them into closest meaningful categories if possible, or mention them generically.
                3. Beneficiary Profile: Describe progress in reaching beneficiary groups, total number reached, and whether vulnerable/priority groups were included.

                Constraints:
                - Do NOT interpret outcomes, improvements, or impact (e.g., avoid "improved health" or "empowered community").
                - Focus strictly on what was conducted and delivered.
                - Write exactly 3-4 professional, concise sentences.
                - Use a neutral, institutional tone.
                - Do NOT use markdown (bolding, lists, etc). Output plain text only.

                Data:
                - Activities: ${JSON.stringify(data.activities)}
                - Total Sessions: ${data.total_sessions}
                - Project Duration: ${data.engagementProfile?.engagement_span || 'Not specified'} days
                - Outputs: ${JSON.stringify(data.outputs)}
                - Total Beneficiaries: ${data.project_summary?.distinct_total_beneficiaries}
                - Beneficiary Categories: ${JSON.stringify(data.beneficiary_categories)}
                - Team Contributions: ${JSON.stringify(data.team_contributions)}`;

      // =====================================================
      // SECTION 4 EVALUATION
      // =====================================================
      case 'section4_evaluation':
        return `Evaluate Section 4 — ACTIVITIES, OUTPUTS & SCALE and calculate the Composite Impact Index (CII) score.

INPUTS:
Data: ${JSON.stringify(data)}

SECTION 4 — ACTIVITIES, OUTPUTS & SCALE
Weight = 15
Core Formula
S4=15×(0.25*A + 0.25*O + 0.20*B + 0.15*M + 0.15*S)

Where:
A = Activity Block Quality
O = Output Quality & Measurability
B = Beneficiary Reach & Counting Clarity
M = Delivery & Implementation Model Clarity
S = Scale Credibility & Implementation Magnitude

Each variable is scored from 0 to 1 using numeric benchmarks:
1.00 = Excellent, 0.80 = Good, 0.60 = Moderate, 0.40 = Weak, 0.20 = Very Weak, 0.00 = Absent

A = 0.20*A1 + 0.20*A2 + 0.25*A3 + 0.15*A4 + 0.20*A5
O = 0.20*O1 + 0.25*O2 + 0.20*O3 + 0.20*O4 + 0.15*O5
B = 0.20*B1 + 0.20*B2 + 0.20*B3 + 0.20*B4 + 0.20*B5
M = 0.20*M1 + 0.20*M2 + 0.20*M3 + 0.20*M4 + 0.20*M5
S = 0.20*S1 + 0.20*S2 + 0.20*S3 + 0.15*S4 + 0.25*S5

OUTPUT FORMAT
Return:
Activity Quality (A) = ___
Output Quality (O) = ___
Beneficiary Clarity (B) = ___
Delivery Clarity (M) = ___
Scale Credibility (S) = ___

Section 4 CII Score = ___ / 15
Classify quality: 13-15=Excellent, 10.5-12.9=Good, 8-10.4=Moderate, 5-7.9=Weak, 0-4.9=Very Weak

SECTION 4 AUDIT GUARDRAIL (MANDATORY):
Do not score activities, outputs, beneficiaries, or scale only from entered numbers. Validate realism against verified hours, sessions, evidence, and team size.
Specifically check:
- Are activities clearly described?
- Are outputs measurable (not generic claims)?
- Are beneficiary numbers realistic and counted with method?
- Do outputs and scale align with evidence and attendance?
- Are there inflation signals?

Section 4 cap rules (apply if triggered):
- Activities done but outputs vague: max 10/15
- Beneficiary numbers inflated: max 8/15
- Evidence does not support outputs: max 7/15
- Major contradiction in scale: max 5/15

Provide a brief explanation of the score.`;

      // =====================================================
      // SECTION 5 AUTO SUMMARY
      // =====================================================
      case 'section5_summary':
        return `
Generate a concise outcome summary for Section 5 — Outcomes & Results.

Inputs:
Primary SDG: ${data.primary_sdg}
SDG Target: ${data.sdg_target}
Total Beneficiaries Reached: ${data.project_summary?.distinct_total_beneficiaries}
Output Types Recorded: ${JSON.stringify(data.outputs)}
Observed Change Narrative: ${data.observed_change}
Measurable Outcomes: ${JSON.stringify(data.measurable_outcomes)}
Challenges & Limitations Narrative: ${data.challenges}

Instructions:
1. Summarize the main change observed among beneficiaries.
2. Briefly reference the measurable outcome (baseline vs endline).
3. Indicate the type of outcome achieved (skills, behaviour, access etc).
4. Acknowledge any key limitation if mentioned.

Rules:
Maximum 50 words.
Use neutral professional language.
Do not exaggerate impact.
Do not claim SDG achievement.

Output:
Write one concise paragraph (35–50 words).
`;

      // =====================================================
      // SECTION 5 EVALUATION
      // =====================================================
      case 'section5_evaluation':
        return `Evaluate Section 5 — OUTCOMES & RESULTS and calculate the Composite Impact Index (CII) score.

INPUTS:
Data: ${JSON.stringify(data)}

SECTION 5 — OUTCOMES & RESULTS
Weight = 20
Core Formula
S5=20×(0.25*N + 0.30*M + 0.20*C + 0.15*L + 0.10*R)

Where:
N = quality of change narrative
M = measurable outcome strength
C = confidence / credibility of measurement
L = linkage with outputs and baseline
R = realism of claims

SCORING SCALE FOR ALL SUB-INDICATORS:
1.00 = Excellent / fully demonstrated
0.75 = Good / mostly demonstrated
0.50 = Moderate / partially demonstrated
0.25 = Weak / minimally demonstrated
0.00 = Very weak / absent / unsupported

1) N = QUALITY OF CHANGE NARRATIVE
N = 0.25*N1 + 0.20*N2 + 0.20*N3 + 0.15*N4 + 0.20*N5
(N1: change stated, N2: affected group identified, N3: type of change described, N4: before/after logic present, N5: narrative specificity/coherence)

2) M = MEASURABLE OUTCOME STRENGTH
M = 0.20*M1 + 0.20*M2 + 0.20*M3 + 0.20*M4 + 0.20*M5
(M1: outcome is measurable, M2: relevant metric/unit, M3: value/magnitude provided, M4: reflects change not activity, M5: strength/significance)

3) C = CONFIDENCE / CREDIBILITY OF MEASUREMENT
C = 0.20*C1 + 0.20*C2 + 0.20*C3 + 0.20*C4 + 0.20*C5
(C1: source identified, C2: method explained, C3: evidence exists, C4: consistency with implementation, C5: credibility of inference)

4) L = LINKAGE WITH OUTPUTS AND BASELINE
L = 0.20*L1 + 0.20*L2 + 0.20*L3 + 0.20*L4 + 0.20*L5
(L1: baseline-to-outcome, L2: activity-to-outcome, L3: output-to-outcome, L4: internal consistency, L5: attributable to intervention)

5) R = REALISM OF CLAIMS
R = 0.25*R1 + 0.25*R2 + 0.20*R3 + 0.15*R4 + 0.15*R5
(R1: proportionality, R2: plausibility of magnitude, R3: evidence sufficiency, R4: absence of exaggeration, R5: acknowledgment of limits)

OUTPUT FORMAT
Return:
Narrative Quality (N) = ___
Measurable Score (M) = ___
Confidence (C) = ___
Linkage (L) = ___
Realism (R) = ___

Section 5 CII Score = ___ / 20

SECTION 5 REALISM GUARDRAIL (MANDATORY):
Apply strict realism. Do not reward outcomes unless linked to baseline, activities, outputs, measurement method, and evidence.
Check:
- Is the outcome measurable (not only narrative)?
- Is there before/after or equivalent comparison logic?
- Is a method of measurement stated?
- Is the claim evidence-backed and proportionate to intervention?
- Are limitations acknowledged?
- Is there overclaiming?

Section 5 cap rules (apply if triggered):
- Outcomes described but not measured: max 13/20
- Outcomes vague/generic: max 10/20
- Outcomes inflated or unsupported: max 8/20
- Outcomes contradict evidence: max 5/20

Provide a brief explanation of the score.`;

      // =====================================================
      // SECTION 6 AUTO SUMMARY
      // =====================================================
      case 'section6_summary':
        return `
Generate the auto-generated summary for Section 6 — Resources & Implementation Support.

Inputs:
Primary SDG: ${data.primary_sdg}
SDG Target: ${data.sdg_target}
Total Beneficiaries Reached: ${data.project_summary?.distinct_total_beneficiaries}
Total Verified Student Hours: ${data.total_verified_hours}
Resource Confirmation Model: ${data.resource_model}
Resource Entries: ${JSON.stringify(data.resources)}
Evidence Upload Presence: ${data.evidence}

Instructions:
1. Identify whether the project relied only on volunteer effort or included additional resources.
2. Briefly summarize the main resource categories used.
3. Mention key supporting sources.
4. Indicate verification level.

Rules:
Maximum 50 words.
Neutral institutional language.

Output:
Write one concise paragraph (35–50 words).
`;

      // =====================================================
      // SECTION 6 EVALUATION
      // =====================================================
      case 'section6_evaluation':
        return `Evaluate Section 6 — RESOURCES & IMPLEMENTATION SUPPORT and calculate the Composite Impact Index (CII) score.

INPUTS:
Data: ${JSON.stringify(data)}

SECTION 6 — RESOURCES & IMPLEMENTATION SUPPORT
Weight = 5
Core Formula
S6=5×(0.30*R + 0.25*S + 0.25*P + 0.20*V)

Where:
R = resource relevance
S = source clarity
P = purpose justification
V = verification of support

SCORING SCALE FOR ALL SUB-INDICATORS:
1.00 = Excellent / fully demonstrated
0.75 = Good / mostly demonstrated
0.50 = Moderate / partially demonstrated
0.25 = Weak / minimally demonstrated
0.00 = Very weak / absent / unsupported

1) R = RESOURCE RELEVANCE
R = 0.25*R1 + 0.25*R2 + 0.20*R3 + 0.15*R4 + 0.15*R5
(R1: relevance to activities, R2: relevance to implementation needs, R3: relevance to outputs, R4: proportionality, R5: absence of decorative entries)

2) S = SOURCE CLARITY
S = 0.25*S1 + 0.20*S2 + 0.20*S3 + 0.15*S4 + 0.20*S5
(S1: source identified, S2: source specificity, S3: source traceability, S4: distinction between sources, S5: overall clarity)

3) P = PURPOSE JUSTIFICATION
P = 0.20*P1 + 0.20*P2 + 0.20*P3 + 0.20*P4 + 0.20*P5
(P1: purpose stated, P2: linked to activity, P3: linked to implementation, P4: explanation of use, P5: specificity/coherence)

4) V = VERIFICATION OF SUPPORT
V = 0.20*V1 + 0.20*V2 + 0.20*V3 + 0.20*V4 + 0.20*V5
(V1: presence of supporting basis, V2: relevance of proof, V3: external confirmation, V4: consistency with records, V5: overall credibility)

OUTPUT FORMAT
Return:
Resource Relevance (R) = ___
Source Clarity (S) = ___
Purpose Justification (P) = ___
Verification (V) = ___

Section 6 CII Score = ___ / 5
Provide a brief explanation of the score.`;

      // =====================================================
      // SECTION 7 SUMMARY
      // =====================================================
      case 'section7_summary':
        return `
Generate the auto-generated summary for Section 7 — Partnerships & Collaboration.

Inputs:
Partnership Confirmation: ${data.confirmation}
Partner Entries: ${JSON.stringify(data.partners)}
Partnership Documentation: ${data.documentation}

Instructions:
1. Identify whether the project involved partners or implemented independently.
2. State number and types of partners.
3. Briefly describe main roles or contributions.
4. Mention verification level and formal documentation.

Rules:
Maximum 50 words. Neutral factual institutional language.

Output:
Write one concise paragraph (35–50 words).
`;

      // =====================================================
      // SECTION 7 EVALUATION
      // =====================================================
      case 'section7_evaluation':
        return `Evaluate Section 7 — PARTNERSHIPS & COLLABORATION and calculate the Composite Impact Index (CII) score.

INPUTS:
Data: ${JSON.stringify(data)}

SECTION 7 — PARTNERSHIPS & COLLABORATION
Weight = 5
Core Formula
S7=5×(0.25*Re + 0.25*Ro + 0.25*Co + 0.25*Ve)

Where:
Re = partner relevance
Ro = role clarity
Co = contribution depth
Ve = verification strength

SCORING SCALE FOR ALL SUB-INDICATORS:
1.00 = Excellent / fully demonstrated
0.75 = Good / mostly demonstrated
0.50 = Moderate / partially demonstrated
0.25 = Weak / minimally demonstrated
0.00 = Very weak / absent / unsupported

1) Re = PARTNER RELEVANCE
Re = 0.25*Re1 + 0.20*Re2 + 0.20*Re3 + 0.20*Re4 + 0.15*Re5
(Re1: relevance to problem, Re2: relevance to activities, Re3: relevance to beneficiaries, Re4: relevance to outcomes, Re5: non-decorative fit)

2) Ro = ROLE CLARITY
Ro = 0.20*Ro1 + 0.20*Ro2 + 0.20*Ro3 + 0.20*Ro4 + 0.20*Ro5
(Ro1: role explicitly stated, Ro2: role is specific, Ro3: role linked to function, Ro4: role distinction from others, Ro5: overall clarity)

3) Co = CONTRIBUTION DEPTH
Co = 0.20*Co1 + 0.20*Co2 + 0.20*Co3 + 0.20*Co4 + 0.20*Co5
(Co1: type significance, Co2: usefulness to project, Co3: depth/intensity, Co4: effect on delivery, Co5: continuity/value)

4) Ve = VERIFICATION STRENGTH
Ve = 0.20*Ve1 + 0.20*Ve2 + 0.20*Ve3 + 0.20*Ve4 + 0.20*Ve5
(Ve1: evidence exists, Ve2: evidence is relevant, Ve3: external confirmation strength, Ve4: consistency with records, Ve5: overall credibility)

OUTPUT FORMAT
Return:
Partner Relevance (Re) = ___
Role Clarity (Ro) = ___
Contribution Depth (Co) = ___
Verification Strength (Ve) = ___

Section 7 CII Score = ___ / 5
Provide a brief explanation of the score.`;

      // =====================================================
      // SECTION 8 SUMMARY
      // =====================================================
      case 'section8_summary':
        return `
Generate the auto-generated summary for Section 8 — Evidence, Verification & Ethical Compliance.

Inputs:
Evidence Files Uploaded: ${data.evidence_count}
Evidence Types: ${JSON.stringify(data.evidence_types)}
Evidence Description: ${data.description}
Ethical Compliance: ${data.ethics}
Partner Verification: ${data.partner_verification}

Instructions:
1. State quantity and types of evidence.
2. Mention ethical confirmations and partner verification.
3. Describe documentation level.

Rules:
Maximum 50 words. Neutral institutional tone.

Output:
Write one concise paragraph (35–50 words).
`;

      // =====================================================
      // SECTION 8 EVALUATION
      // =====================================================
      case 'section8_evaluation':
        return `Evaluate Section 8 — EVIDENCE RELIABILITY, ETHICS & VERIFICATION and calculate the Composite Impact Index (CII) score.

INPUTS:
Data: ${JSON.stringify(data)}

SECTION 8 — EVIDENCE RELIABILITY, ETHICS & VERIFICATION
Weight = 5
Core Formula
S8=5×(0.30*C + 0.25*V + 0.20*R + 0.15*E + 0.10*X)

Where:
C = cross-section consistency
V = external verification strength
R = relevance of uploaded proof
E = ethics compliance
X = absence of contradiction / suspicion

SCORING SCALE FOR ALL SUB-INDICATORS:
1.00 = Excellent / fully reliable
0.75 = Good / mostly reliable
0.50 = Moderate / partially reliable
0.25 = Weak / doubtful
0.00 = Very weak / absent / strongly suspicious

1) C = CROSS-SECTION CONSISTENCY
C = 0.25*C1 + 0.25*C2 + 0.20*C3 + 0.15*C4 + 0.15*C5
(C1: consistency with attendance, C2: consistency with activities, C3: consistency with outputs, C4: consistency with partners, C5: consistency with timeline)

2) V = EXTERNAL VERIFICATION STRENGTH
V = 0.20*V1 + 0.20*V2 + 0.20*V3 + 0.20*V4 + 0.20*V5
(V1: existence of external verification, V2: relevance, V3: specificity, V4: credibility of source, V5: strength of linkage to claims)

3) R = RELEVANCE OF UPLOADED PROOF
R = 0.25*R1 + 0.20*R2 + 0.20*R3 + 0.20*R4 + 0.15*R5
(R1: relevance to activity, R2: relevance to output, R3: relevance to context, R4: interpretability of proof, R5: file-type appropriateness)

4) E = ETHICS COMPLIANCE
E = 0.25*E1 + 0.20*E2 + 0.20*E3 + 0.20*E4 + 0.15*E5
(E1: no harmful sensitive exposure, E2: dignity maintained, E3: contextually appropriate use, E4: consent/permission logic, E5: no exploitative style)

5) X = ABSENCE OF CONTRADICTION / SUSPICION
X = 0.20*X1 + 0.20*X2 + 0.20*X3 + 0.20*X4 + 0.20*X5
(X1: absence of duplication, X2: timeline alignment, X3: numerical consistency, X4: no inflation signals, X5: overall suspicion-free profile)

OUTPUT FORMAT
Return:
Cross-Section Consistency (C) = ___
External Verification (V) = ___
Relevance of Proof (R) = ___
Ethics Compliance (E) = ___
Absence of Contradiction (X) = ___

Section 8 CII Score = ___ / 5

SECTION 8 EVIDENCE AUDIT GUARDRAIL (MANDATORY):
Evidence must only strengthen score if it is relevant, attributable, time-aligned, ethical, and internally consistent.
Check for duplicate/unrelated files, weak linkage, date mismatch, unsupported partner claims, inflated numbers not visible in proof, suspicious staging, and contradictions with attendance/activities/outcomes/resources.

Section 8 cap rules (apply if triggered):
- Some evidence but weak linkage: max 3.5/5
- Evidence vague or insufficient: max 2.5/5
- Evidence contradicts claims: max 1.5/5
- Evidence appears fake/unethical: max 0.5/5

Provide a brief explanation of the score.`;

      // =====================================================
      // SECTION 9 SUMMARY
      // =====================================================
      case 'section9_summary':
        return `
Generate the auto-generated summary for Section 9 — Reflection, Learning & Academic Integration.

Inputs:
Academic Integration Level: ${data.integration_level}
Personal Reflection: ${data.reflection}
Academic Application: ${data.academic_application}
Competency Ratings: ${JSON.stringify(data.competencies)}

Instructions:
1. Summarize key learning outcomes and academic knowledge application.
2. Indicate competency development and sustainability thinking.

Rules:
Maximum 50 words. Neutral institutional tone.

Output:
Write one concise paragraph (35–50 words).
`;

      // =====================================================
      // SECTION 9 EVALUATION
      // =====================================================
      case 'section9_evaluation':
        return `Evaluate Section 9 — REFLECTION, LEARNING & COMPETENCY DEVELOPMENT and calculate the Composite Impact Index (CII) score.

INPUTS:
Data: ${JSON.stringify(data)}

SECTION 9 — REFLECTION, LEARNING & COMPETENCY DEVELOPMENT
Weight = 5
Core Formula
S9=5×(0.30*L + 0.25*A + 0.25*C + 0.20*T)

Where:
L = learning depth
A = academic application
C = competency insight
T = transformative understanding

SCORING SCALE FOR ALL SUB-INDICATORS:
1.00 = Excellent / fully demonstrated
0.75 = Good / mostly demonstrated
0.50 = Moderate / partially demonstrated
0.25 = Weak / minimally demonstrated
0.00 = Very weak / absent / unsupported

1) L = LEARNING DEPTH
L = 0.20*L1 + 0.20*L2 + 0.20*L3 + 0.20*L4 + 0.20*L5
(L1: lesson identified clearly, L2: lesson specific to project, L3: reflection beyond description, L4: connected to real experience, L5: depth and maturity)

2) A = ACADEMIC APPLICATION
A = 0.20*A1 + 0.20*A2 + 0.20*A3 + 0.20*A4 + 0.20*A5
(A1: academic field identified, A2: concept/tool referenced, A3: applied meaningfully, A4: relevant to project, A5: explanation clear and specific)

3) C = COMPETENCY INSIGHT
C = 0.20*C1 + 0.20*C2 + 0.20*C3 + 0.20*C4 + 0.20*C5
(C1: competency identified, C2: relevant to project, C3: development explained, C4: supported by examples, C5: self-awareness shown)

4) T = TRANSFORMATIVE UNDERSTANDING
T = 0.20*T1 + 0.20*T2 + 0.20*T3 + 0.20*T4 + 0.20*T5
(T1: perspective shift identified, T2: social/ethical understanding deepened, T3: personal/professional growth insight, T4: connected to community realities, T5: durable meaning)

OUTPUT FORMAT
Return:
Learning Depth (L) = ___
Academic Application (A) = ___
Competency Insight (C) = ___
Transformative Understanding (T) = ___

Section 9 CII Score = ___ / 5

WRITING QUALITY GUARDRAIL:
Do not heavily penalize minor language mistakes when meaning is clear. But if writing is vague, repetitive, generic, unclear, or appears template/AI-like without personal insight, reduce this section score appropriately.

Provide a brief explanation of the score.`;

      // =====================================================
      // SECTION 10 SUMMARY
      // =====================================================
      case 'section10_summary':
        return `
Generate the auto-generated summary for Section 10 — Sustainability & Continuation.

Inputs:
Continuation Status: ${data.status}
Continuation Explanation: ${data.explanation}
Sustainability Mechanisms: ${JSON.stringify(data.mechanisms)}
Scaling Potential: ${data.scaling}
Policy Influence: ${data.policy}

Instructions:
1. State continuation status and mechanisms.
2. Indicate scaling potential and policy influence.

Rules:
Maximum 50 words. Neutral institutional tone.

Output:
Write one concise paragraph (35–50 words).
`;

      // =====================================================
      // SECTION 10 EVALUATION
      // =====================================================
      case 'section10_evaluation':
        return `Evaluate Section 10 — SUSTAINABILITY, CONTINUATION & SCALING and calculate the Composite Impact Index (CII) score.

INPUTS:
Data: ${JSON.stringify(data)}

SECTION 10 — SUSTAINABILITY, CONTINUATION & SCALING
Weight = 5
Core Formula
S10=5×(0.30*C + 0.25*M + 0.25*S + 0.20*P)

Where:
C = continuation realism
M = sustainability mechanism strength
S = scaling potential
P = policy/system relevance

SCORING SCALE FOR ALL SUB-INDICATORS:
1.00 = Excellent / fully demonstrated
0.75 = Good / mostly demonstrated
0.50 = Moderate / partially demonstrated
0.25 = Weak / minimally demonstrated
0.00 = Very weak / absent / unsupported

1) C = CONTINUATION REALISM
C = 0.20*C1 + 0.20*C2 + 0.20*C3 + 0.20*C4 + 0.20*C5
(C1: continuation plan stated, C2: what will continue is identified, C3: limits/stops acknowledged, C4: support requirements identified, C5: claim is realistic)

2) M = SUSTAINABILITY MECHANISM STRENGTH
M = 0.20*M1 + 0.20*M2 + 0.20*M3 + 0.20*M4 + 0.20*M5
(M1: mechanism exists, M2: mechanism relevance, M3: mechanism clarity, M4: mechanism feasibility, M5: mechanism strength/dependability)

3) S = SCALING POTENTIAL
S = 0.20*S1 + 0.20*S2 + 0.20*S3 + 0.20*S4 + 0.20*S5
(S1: scaling possibility identified, S2: replicability of project model, S3: transferability, S4: enabling conditions exist, S5: scaling claim is realistic)

4) P = POLICY / SYSTEM RELEVANCE
P = 0.20*P1 + 0.20*P2 + 0.20*P3 + 0.20*P4 + 0.20*P5
(P1: system/policy relevance identified, P2: connection to issue, P3: practical value beyond immediate project, P4: broader usefulness, P5: realism of claim)

OUTPUT FORMAT
Return:
Continuation Realism (C) = ___
Sustainability Mechanism Strength (M) = ___
Scaling Potential (S) = ___
Policy/System Relevance (P) = ___

Section 10 CII Score = ___ / 5

WRITING QUALITY GUARDRAIL:
Do not heavily penalize minor language mistakes when meaning is clear. But if writing is vague, repetitive, generic, unclear, or appears template/AI-like without personal insight, reduce this section score appropriately.

Provide a brief explanation of the score.`;

      // =====================================================
      // CII INDEX OVERALL REVIEW
      // =====================================================
      case 'cii_index':
        return `You are ChatGPT acting as a CIEL Composite Impact Index (CII) auditor.

Review the submitted report data and the calculated CII index values. Do not invent missing evidence.

INPUTS:
Data: ${JSON.stringify(data)}

TASK:
1. Explain the overall CII index score in professional institutional language.
2. Identify the strongest scoring areas.
3. Identify weak or risky areas that may reduce the CII index.
4. Cross-check whether the numeric score is consistent with the report evidence.
5. Provide short improvement guidance without changing the score.

OUTPUT FORMAT:
CII Index Score: ___ / 100
CII Level: ___
Score Interpretation: ___
Strong Areas: ___
Weak Areas / Risks: ___
Audit Remark: ___

Keep the full response under 180 words.`;

      // =====================================================
      // SECTION 11 EXECUTIVE SUMMARY
      // =====================================================
      case 'section11':
        return buildSection11EvaluationUserMessage(data);

      case 'section11_master_rubric':
        return buildSection11MasterRubricUserMessage(data);

      default:
        return `Summarize project data professionally: ${JSON.stringify(data)}`;
    }
  }

  async summarize(section: string, data: any): Promise<AiSummarizeResult> {
    if (!process.env.OPENAI_API_KEY?.trim()) {
      throw new HttpException({ error: 'OpenAI API key is not configured' }, 500);
    }

    const prompt = this.buildPrompt(section, data);

    const isSection11Evaluation =
      section === 'section11' || section === 'section11_master_rubric';

    const openAiOpts: OpenAiCompletionOpts | undefined = isSection11Evaluation
      ? {
          temperature: 0.15,
          seed: section === 'section11_master_rubric' ? 4212 : 4210,
          maxTokens: 16000,
          responseFormat: { type: 'json_object' },
          systemMessage:
            section === 'section11_master_rubric'
              ? `${SECTION11_MASTER_RUBRIC_EVALUATOR_PROMPT}\n\n${SECTION11_MASTER_RUBRIC_JSON_ONLY_DEPLOYMENT_NOTE}`
              : `${SECTION11_EVALUATOR_PROMPT}\n\n${SECTION11_JSON_ONLY_DEPLOYMENT_NOTE}`,
        }
      : undefined;

    let text: string;
    try {
      text = await this.generateSummaryWithOpenAI(prompt, openAiOpts);
    } catch (error: unknown) {
      const status =
        typeof error === 'object' && error !== null && 'status' in error
          ? (error as { status?: unknown }).status
          : undefined;
      if (status === 429) {
        throw new HttpException({ error: 'AI limit reached. Please wait.' }, 429);
      }
      if (status === 503) {
        throw new HttpException({ error: 'AI servers overloaded. Try again shortly.' }, 503);
      }
      throw new HttpException({ error: resolveOpenAiErrorMessage(error) }, 500);
    }

    const summary = text.trim();

    if (isSection11Evaluation) {
      const v81 = parseSection11V81Response(summary);
      if (v81) {
        return {
          summary: v81.summaryText,
          auditMeta: v81.auditMeta,
          evaluationVersion: v81.evaluation.framework_version || 'v8.2',
        };
      }

      const v61 = parseSection11V61Response(summary);
      if (v61) {
        return {
          summary: v61.summaryText,
          auditMeta: v61.auditMeta,
          evaluationVersion: v61.evaluation.evaluation_version || 'v6.4',
        };
      }

      const auditMeta = parseSection11AuditSummary(summary);
      return {
        summary,
        ...(auditMeta ? { auditMeta } : {}),
      };
    }

    return { summary };
  }
}

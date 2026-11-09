import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type { FollowUpDispatchKind } from './entities/follow-up-dispatch.entity';
import type { FollowUpProjectReference } from './entities/report-follow-up.entity';

/**
 * Pure helpers for the Section 9.5 follow-up: dates (Asia/Karachi calendar), tokens, the
 * project reference block and the rule-based question generator. No I/O, so every rule here is
 * unit-tested in followup.util.spec.ts.
 */

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string =>
  typeof v === 'string'
    ? v.trim()
    : typeof v === 'number' && Number.isFinite(v)
      ? String(v)
      : '';
const firstStr = (...vals: unknown[]): string => {
  for (const v of vals) {
    const s = str(v);
    if (s) return s;
  }
  return '';
};

// ------------------------------------------------------------------ dates (fixed UTC+5, no DST)

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad2 = (n: number) => String(n).padStart(2, '0');

export function isIsoDate(value: unknown): value is string {
  const m = typeof value === 'string' ? ISO_DATE_RE.exec(value) : null;
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === mo - 1 &&
    dt.getUTCDate() === d
  );
}

/** Any date-ish value → yyyy-mm-dd, or '' when unusable. */
export function normalizeIsoDate(value: unknown): string {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? ''
      : value.toISOString().slice(0, 10);
  }
  const raw = str(value);
  if (!raw) return '';
  if (isIsoDate(raw.slice(0, 10))) return raw.slice(0, 10);
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime())
    ? ''
    : parsed.toISOString().slice(0, 10);
}

/** Today's calendar date in Pakistan (fixed UTC+5), the day the scheduler reasons in. */
export function karachiToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 5 * 3600_000).toISOString().slice(0, 10);
}

export function addDaysIso(iso: string, days: number): string {
  if (!isIsoDate(iso)) return '';
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Calendar-month arithmetic that clamps to the end of a shorter month (31 Jan + 1 = 28/29 Feb). */
export function addMonthsIso(iso: string, months: number): string {
  if (!isIsoDate(iso) || !Number.isFinite(months)) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return `${target.getUTCFullYear()}-${pad2(target.getUTCMonth() + 1)}-${pad2(Math.min(d, lastDay))}`;
}

export const FOLLOWUP_INTERVAL_MONTHS: Record<string, number> = {
  '1': 1,
  '3': 3,
  '6': 6,
  '12': 12,
};

export const FOLLOWUP_INTERVAL_LABELS: Record<string, string> = {
  '1': '1 month after project end',
  '3': '3 months after project end',
  '6': '6 months after project end',
  '12': '12 months after project end',
  custom: 'a chosen date',
};

/** The opportunity's end date (timeline.end_date / end_date), as the student wizard reads it. */
export function resolveProjectEndDate(opportunity: unknown): string {
  const opp = rec(opportunity);
  const timeline = rec(opp.timeline);
  return (
    normalizeIsoDate(timeline.end_date) ||
    normalizeIsoDate(timeline.endDate) ||
    normalizeIsoDate(opp.end_date) ||
    normalizeIsoDate(opp.endDate)
  );
}

/**
 * Due date for a "Yes" plan: the stored due date when valid, else the custom date, else project end
 * + interval. Mirrors the student wizard's computeFollowupDueDate.
 */
export function resolveFollowUpDueDate(
  section10: unknown,
  projectEndDate: string,
): string {
  const s10 = rec(section10);
  const stored = normalizeIsoDate(s10.followup_due_date);
  if (stored) return stored;
  const interval = str(s10.followup_interval) || '3';
  if (interval === 'custom') return normalizeIsoDate(s10.followup_custom_date);
  const months = FOLLOWUP_INTERVAL_MONTHS[interval];
  return months && projectEndDate ? addMonthsIso(projectEndDate, months) : '';
}

export function followUpIntervalLabel(section10: unknown): string {
  const s10 = rec(section10);
  const interval = str(s10.followup_interval) || '3';
  return FOLLOWUP_INTERVAL_LABELS[interval] || interval;
}

// ------------------------------------------------------------------ tokens

export function newFollowUpToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashFollowUpToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function tokenLooksValid(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(token);
}

// ------------------------------------------------------------------ schedule decisions

export type DispatchDecisionInput = {
  today: string;
  dueDate: string;
  reminder1Days: number;
  reminder2Days: number;
  /** Kinds already sent successfully (current recipient cycle). */
  sent: ReadonlySet<FollowUpDispatchKind>;
  /**
   * Karachi date the initial email actually went out. Reminders count from here, so an early
   * "send now" or a late catch-up never produces reminders months later or on consecutive nights.
   */
  initialSentOn?: string;
};

/**
 * Which email (if any) is due today. Reminders only follow a sent initial mail and never repeat;
 * the caller already stopped on responded / declined / cancelled / expired.
 */
export function decideDispatch(
  input: DispatchDecisionInput,
): FollowUpDispatchKind | null {
  if (!isIsoDate(input.dueDate) || !isIsoDate(input.today)) return null;
  if (!input.sent.has('initial')) {
    return input.today >= input.dueDate ? 'initial' : null;
  }
  const anchor = isIsoDate(input.initialSentOn)
    ? input.initialSentOn
    : input.dueDate;
  const r1 = addDaysIso(anchor, Math.max(1, input.reminder1Days));
  const r2 = addDaysIso(anchor, Math.max(2, input.reminder2Days));
  if (!input.sent.has('reminder1') && input.today >= r1) return 'reminder1';
  if (!input.sent.has('reminder2') && input.today >= r2) return 'reminder2';
  return null;
}

// ------------------------------------------------------------------ project reference

export function buildProjectReference(
  report: Rec,
  opportunity: unknown,
): FollowUpProjectReference {
  const opp = rec(opportunity);
  const org = rec(opp.organization);
  const partnerOrg = rec(opp.partner_organization);
  const execOrg = rec(opp.executing_organization);
  const location = rec(opp.location);
  const timeline = rec(opp.timeline);
  const objectives = rec(opp.objectives);
  const s1 = rec(report.section1);
  const lead = rec(s1.team_lead);
  const s4 = rec(report.section4);
  const summary = rec(s4.project_summary);
  const s2 = rec(report.section2);

  const memberNames = [
    firstStr(lead.fullName, lead.name),
    ...arr(s1.team_members).map((m) => firstStr(rec(m).fullName, rec(m).name)),
  ].filter(Boolean);

  const beneficiaries = firstStr(
    summary.distinct_total_beneficiaries,
    rec(objectives).beneficiaries_count,
    s2.affected_count,
  );
  const group = firstStr(s2.affected_group, rec(objectives).beneficiaries_type);

  return {
    title: firstStr(
      opp.title,
      report.project_title,
      'Community engagement project',
    ),
    projectId: firstStr(opp.publicId, opp.public_id, opp.id, report.project_id),
    reportId: firstStr(report.publicId, report.public_id, report.id),
    host: firstStr(
      org.name,
      partnerOrg.organization_name,
      execOrg.name,
      opp.organization_name,
    ),
    university: firstStr(lead.universityName, lead.university, opp.university),
    location: [
      firstStr(location.venue),
      firstStr(location.city, location.district),
    ]
      .filter(Boolean)
      .join(', '),
    periodStart:
      normalizeIsoDate(timeline.start_date) || normalizeIsoDate(opp.start_date),
    periodEnd: resolveProjectEndDate(opportunity),
    objective: firstStr(
      objectives.description,
      opp.description,
      s2.problem_statement,
    ).slice(0, 400),
    beneficiaries: [beneficiaries, group].filter(Boolean).join(' '),
    studentTeam: memberNames.join(', '),
  };
}

// ------------------------------------------------------------------ question generation

export type GeneratedFollowUpQuestion = {
  activityId: string | null;
  activityTitle: string;
  questionText: string;
  countLabel: string | null;
  sourceFieldIds: string[];
  reason: string;
};

export const MAX_FOLLOWUP_QUESTIONS = 5;
export const MAX_ACTIVITY_QUESTIONS = 4;

const NOT_DELIVERED_RE =
  /cancel|not deliver|not started|not complet|planned|proposed|pending|dropped/i;
/** One-time relief with no expected lasting outcome: the spec says not to force verification. */
const ONE_TIME_RELIEF_RE =
  /\b(ration|relief|iftar|meal|meals|food drive|food distribution|blanket|flood camp|one[- ]time|one[- ]off)\b/i;

type Kind =
  | 'plantation'
  | 'facility'
  | 'training'
  | 'distribution'
  | 'health'
  | 'digital'
  | 'generic';

function classifyActivity(text: string): Kind {
  if (/\b(tree|trees|plant|plantation|sapling|garden|nursery)\b/i.test(text))
    return 'plantation';
  if (
    /\b(paint|renovat|repair|classroom|construct|build|infrastructure|install|wiring|light|fan|toilet|washroom|water (tank|filter|pump)|solar|furniture|bench|roof|floor|wall)\b/i.test(
      text,
    )
  )
    return 'facility';
  if (
    /\b(train|training|workshop|skill|capacity|teach|teaching|tutor|tutoring|session|awareness|literacy|coach|mentor|class)\b/i.test(
      text,
    )
  )
    return 'training';
  if (
    /\b(distribut|kit|kits|book|books|material|device|laptop|tablet|supply|supplies|stationery|uniform|wheelchair|provide|provision|donat)\b/i.test(
      text,
    )
  )
    return 'distribution';
  if (
    /\b(health|medical|clinic|screen|screening|vaccin|hygiene|dental|first aid)\b/i.test(
      text,
    )
  )
    return 'health';
  if (
    /\b(digital|app|website|software|system|portal|database|online)\b/i.test(
      text,
    )
  )
    return 'digital';
  return 'generic';
}

function templateFor(kind: Kind, title: string): string {
  const t = `“${title}”`;
  switch (kind) {
    case 'plantation':
      return `Are the trees or plants from ${t} still alive and being looked after?`;
    case 'facility':
      return `Is the work completed under ${t} still in use and in working condition?`;
    case 'training':
      return `Are the people who took part in ${t} still using what they learned?`;
    case 'distribution':
      return `Are the items provided through ${t} still available and being used?`;
    case 'health':
      return `Have the health services or practices introduced in ${t} continued?`;
    case 'digital':
      return `Is the system or tool set up in ${t} still in regular use?`;
    default:
      return `Have the benefits of ${t} continued since the student team finished?`;
  }
}

function countLabelFor(kind: Kind, outputs: Rec[]): string | null {
  const withQty = outputs.find((o) => Number(str(o.quantity)) > 0);
  const label = (o: Rec) =>
    firstStr(o.title, o.type_other, o.type)
      .replace(/^[^\p{L}\p{N}]+/u, '')
      .trim();
  if (withQty) {
    const name = label(withQty);
    const qty = str(withQty.quantity);
    const verb =
      kind === 'plantation'
        ? 'still surviving'
        : kind === 'training'
          ? 'still applying the skills'
          : 'still in use';
    return name ? `${name} ${verb} (of ${qty})` : null;
  }
  if (kind === 'plantation') return 'Trees still surviving';
  if (kind === 'training') return 'People still applying the skills';
  return null;
}

function activityDelivered(block: Rec): boolean {
  const status = str(block.status);
  return !status || !NOT_DELIVERED_RE.test(status);
}

/**
 * Rule-based extraction (spec §2, offline default): one distinct question per delivered Section 4
 * activity (max 4), each enriched with the linked Section 5 outcome, plus one overall question that
 * carries the student's own 9.5 focus. Never claims completion for planned or undelivered work.
 */
export function generateFollowUpQuestions(
  report: Rec,
): GeneratedFollowUpQuestion[] {
  const s4 = rec(report.section4);
  const s5 = rec(report.section5);
  const s10 = rec(report.section10);
  const blocks = arr(s4.activity_blocks).map(rec);
  const outcomes = arr(s5.measurable_outcomes).map(rec);

  const out: GeneratedFollowUpQuestion[] = [];
  const seenTitles = new Set<string>();

  blocks.forEach((block, index) => {
    if (out.length >= MAX_ACTIVITY_QUESTIONS) return;
    const title = firstStr(
      block.title,
      block.other_category_text,
      block.sub_category,
    );
    if (!title) return;
    const key = title.toLowerCase().replace(/\s+/g, ' ');
    if (seenTitles.has(key)) return;
    if (!activityDelivered(block)) return;
    const haystack = [
      title,
      str(block.description),
      str(block.primary_category),
      str(block.sub_category),
      ...arr(block.outputs).map((o) => firstStr(rec(o).title, rec(o).type)),
    ].join(' ');
    // Pure one-time relief only gets a question when nothing else can be asked.
    if (ONE_TIME_RELIEF_RE.test(haystack) && blocks.length > 1) return;
    const kind = classifyActivity(haystack);
    const outputs = arr(block.outputs).map(rec);
    const activityId = firstStr(block.id) || `activity-${index + 1}`;
    const linked = outcomes
      .map((o, i) => ({ o, i }))
      .filter(
        ({ o }) => str(o.activity_id) && str(o.activity_id) === activityId,
      );
    const sourceFieldIds = [
      `section4.activity_blocks[${index}]`,
      ...linked.map(({ i }) => `section5.measurable_outcomes[${i}]`),
    ];
    const reasons = linked
      .map(({ o }) => {
        const metric = firstStr(o.metric_other, o.metric);
        const before = str(o.baseline);
        const after = str(o.endline);
        return metric && (before || after)
          ? `Reported change: ${metric} ${before || '—'} → ${after || '—'}`
          : '';
      })
      .filter(Boolean);
    seenTitles.add(key);
    out.push({
      activityId,
      activityTitle: title,
      questionText: templateFor(kind, title),
      countLabel: countLabelFor(kind, outputs),
      sourceFieldIds,
      reason:
        reasons[0] || `Verify that “${title}” still benefits the community`,
    });
  });

  // The student's own 9.5 focus becomes the closing overall question (always present).
  const focusNote = str(s10.followup_check_notes);
  const focus = str(s10.followup_check);
  const overall = focusNote
    ? /\?$/.test(focusNote)
      ? focusNote
      : `Please confirm: ${focusNote.replace(/\.$/, '')}.`
    : 'Overall, are the benefits reported by the student team still continuing?';
  out.push({
    activityId: null,
    activityTitle: 'Overall project',
    questionText: overall,
    countLabel: null,
    sourceFieldIds: [
      'section10.followup_check',
      'section10.followup_check_notes',
    ].filter((id) =>
      id.endsWith('notes') ? Boolean(focusNote) : Boolean(focus),
    ),
    reason: focus
      ? `Student asked to check: ${focus}`
      : 'Student requested a follow-up check',
  });

  return out.slice(0, MAX_FOLLOWUP_QUESTIONS);
}

// ------------------------------------------------------------------ outcomes (analytics)

export type FollowUpOutcomeBucket =
  | 'continuing'
  | 'partially_continuing'
  | 'stopped'
  | 'unable_to_verify'
  | 'mixed'
  | 'no_response';

export type FollowUpOutcomeSummary = {
  bucket: FollowUpOutcomeBucket;
  yes: number;
  partially: number;
  no: number;
  unable: number;
  answered: number;
};

/**
 * Per-question answers rolled into one label for the tracker. "No response" is its own bucket and
 * never reads as a negative result (spec §5).
 */
export function summarizeOutcomes(
  choices: ReadonlyArray<string>,
): FollowUpOutcomeSummary {
  const yes = choices.filter((c) => c === 'yes').length;
  const partially = choices.filter((c) => c === 'partially').length;
  const no = choices.filter((c) => c === 'no').length;
  const unable = choices.filter((c) => c === 'unable_to_verify').length;
  const answered = yes + partially + no + unable;
  let bucket: FollowUpOutcomeBucket = 'no_response';
  if (answered > 0) {
    const verified = yes + partially + no;
    if (verified === 0) bucket = 'unable_to_verify';
    else if (no === verified) bucket = 'stopped';
    else if (yes === verified) bucket = 'continuing';
    else if (no === 0) bucket = 'partially_continuing';
    else bucket = 'mixed';
  }
  return { bucket, yes, partially, no, unable, answered };
}

// ------------------------------------------------------------------ mail provider webhook

export type MailWebhookEventType =
  | 'delivered'
  | 'deferred'
  | 'bounced'
  | 'complained';

export type NormalizedMailEvent = {
  messageId: string;
  email: string;
  type: MailWebhookEventType;
  detail: string;
  at: string;
};

// Order matters: "delivery_delayed" / "DeliveryDelay" must read as deferred, not delivered.
const EVENT_TYPE_MAP: Array<[RegExp, MailWebhookEventType]> = [
  [/defer|delay/i, 'deferred'],
  [/complain|spam|abuse/i, 'complained'],
  [/bounce|fail|reject|undeliver/i, 'bounced'],
  [/deliver/i, 'delivered'],
];

/** Soft bounces (mailbox full, greylisting, transient) are not a dead address. */
const TRANSIENT_BOUNCE_RE =
  /transient|temporar|soft|mailbox ?full|over quota|quota exceeded|greylist|try again|4\.\d\.\d/i;

function eventTypeOf(raw: unknown): MailWebhookEventType | null {
  const s = str(raw);
  if (!s) return null;
  for (const [re, type] of EVENT_TYPE_MAP) if (re.test(s)) return type;
  return null;
}

/**
 * Accepts the generic CIEL shape `{events:[{messageId,type,email?,detail?,timestamp?}]}` (or one
 * such event), Resend's `{type:'email.bounced',data:{email_id,to,...}}` and an SES notification
 * (`notificationType`, `mail.messageId`, `bounce.bouncedRecipients`). Unknown events are dropped.
 */
export function normalizeMailWebhookEvents(
  payload: unknown,
): NormalizedMailEvent[] {
  let root = rec(payload);
  // SES via SNS wraps the notification as `{Type:'Notification', Message:'<json string>'}`.
  if (
    typeof root.Message === 'string' &&
    /^(Notification)$/i.test(str(root.Type))
  ) {
    try {
      root = rec(JSON.parse(root.Message));
      payload = root;
    } catch {
      return [];
    }
  }
  const candidates: Rec[] = [];
  if (Array.isArray(payload)) candidates.push(...payload.map(rec));
  else if (Array.isArray(root.events)) candidates.push(...root.events.map(rec));
  else if (Array.isArray(root.records))
    candidates.push(...root.records.map(rec));
  else candidates.push(root);

  const out: NormalizedMailEvent[] = [];
  for (const ev of candidates) {
    const data = rec(ev.data);
    const mail = rec(ev.mail);
    const bounce = rec(ev.bounce);
    const complaint = rec(ev.complaint);
    const type = eventTypeOf(
      ev.type ??
        ev.event ??
        ev.notificationType ??
        ev.eventType ??
        rec(ev.event).type,
    );
    if (!type) continue;
    const messageId = firstStr(
      ev.messageId,
      ev.message_id,
      ev.providerMessageId,
      data.email_id,
      data.message_id,
      mail.messageId,
      rec(ev.message).id,
    );
    const recipients = [
      ...arr(bounce.bouncedRecipients).map((r) =>
        firstStr(rec(r).emailAddress),
      ),
      ...arr(complaint.complainedRecipients).map((r) =>
        firstStr(rec(r).emailAddress),
      ),
      ...arr(data.to).map(str),
      ...arr(mail.destination).map(str),
      ...arr(ev.to).map(str),
      str(ev.email),
      str(ev.recipient),
      str(data.email),
    ].filter(Boolean);
    const email = (recipients[0] || '').toLowerCase();
    if (!messageId && !email) continue;
    const detail = firstStr(
      ev.detail,
      ev.reason,
      ev.description,
      rec(bounce.bouncedRecipients?.[0] ?? {}).diagnosticCode,
      bounce.bounceType,
      data.bounce && rec(data.bounce).message,
      str(ev.type),
    ).slice(0, 500);
    const transientHint = [
      str(bounce.bounceType),
      str(bounce.bounceSubType),
      str(ev.bounce_type),
      str(ev.bounceType),
      str(rec(data.bounce).type),
      detail,
    ].join(' ');
    out.push({
      messageId,
      email,
      type:
        type === 'bounced' && TRANSIENT_BOUNCE_RE.test(transientHint)
          ? 'deferred'
          : type,
      detail,
      at:
        firstStr(ev.timestamp, ev.created_at, ev.occurred_at, mail.timestamp) ||
        new Date().toISOString(),
    });
  }
  return out;
}

/**
 * Webhook authorisation, fail-closed: either `Authorization: Bearer <MAIL_WEBHOOK_SECRET>` or
 * `x-ciel-signature: sha256=<hex HMAC of the raw body>` with the same secret. Secrets shorter than
 * 16 characters are treated as unset.
 */
export function isMailWebhookAuthorized(input: {
  secret: string | undefined;
  authorization?: string;
  signature?: string;
  rawBody?: Buffer | string | null;
}): boolean {
  const secret = (input.secret ?? '').trim();
  if (secret.length < 16) return false;
  const bearer = /^Bearer\s+(.+)$/i.exec((input.authorization ?? '').trim());
  if (bearer) {
    const presented = Buffer.from(bearer[1].trim());
    const expected = Buffer.from(secret);
    if (
      presented.length === expected.length &&
      timingSafeEqual(presented, expected)
    ) {
      return true;
    }
  }
  const sig = /^(?:sha256=)?([a-f0-9]{64})$/i.exec(
    (input.signature ?? '').trim(),
  );
  if (sig && input.rawBody) {
    const digest = createHmac('sha256', secret)
      .update(input.rawBody)
      .digest('hex');
    const a = Buffer.from(sig[1].toLowerCase());
    const b = Buffer.from(digest);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  return false;
}

/** CSV cell: always quoted, quotes doubled, formulas neutralised. */
export function csvCell(value: unknown): string {
  let s =
    value === null || value === undefined
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value as string | number | boolean);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** Opening line of the email by dispatch kind (spec email texts). */
export function followUpIntro(
  kind: FollowUpDispatchKind,
  intervalLabel: string,
): string {
  if (kind === 'reminder1') {
    return 'This is a friendly reminder about the pending project follow-up. Your answers help us assess which outcomes have continued.';
  }
  if (kind === 'reminder2') {
    return 'This is a final reminder to verify the project’s continuing benefits. You can also decline if you are not the correct contact.';
  }
  return `CIEL PK is conducting the scheduled follow-up (${intervalLabel}) for the student community engagement project listed below. Please confirm what has continued since the project ended.`;
}

export function followUpSubject(
  kind: FollowUpDispatchKind,
  projectId: string,
  title: string,
): string {
  const prefix =
    kind === 'initial' || kind === 'manual'
      ? 'Impact follow-up'
      : kind === 'reminder1'
        ? 'Reminder: impact follow-up'
        : 'Final reminder: impact follow-up';
  return `CIEL PK | ${prefix} | ${projectId} | ${title}`;
}

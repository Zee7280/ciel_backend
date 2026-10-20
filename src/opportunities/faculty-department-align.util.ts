import type { DataSource } from 'typeorm';

/**
 * The student's create form asks them to type/select the faculty member's department. That free
 * choice (e.g. "BS Botany") is shown on cards as the faculty's own unit even when the registered
 * faculty's profile says something else. For display, the faculty's profile department wins.
 */

type Json = Record<string, unknown>;
const MAX_DEPTH = 8;

function isObj(v: unknown): v is Json {
  return (
    !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)
  );
}

function normEmail(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

/** Objects in a response that carry a faculty email + a department we may need to correct. */
function visit(
  node: unknown,
  depth: number,
  onTarget: (email: string, set: (dept: string) => void) => void,
) {
  if (depth > MAX_DEPTH || !node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) visit(item, depth + 1, onTarget);
    return;
  }
  if (!isObj(node)) return;
  const sup = node['supervision'];
  if (isObj(sup)) {
    // raw opportunity: supervision.contact + supervision.faculty_department
    const email = normEmail(sup['contact']);
    if (email && 'faculty_department' in sup) {
      onTarget(email, (dept) => {
        sup['faculty_department'] = dept;
      });
    }
    // detail view: supervision.faculty = { email, department, ... }
    const faculty = sup['faculty'];
    if (isObj(faculty)) {
      const fEmail = normEmail(faculty['email']);
      if (fEmail && 'department' in faculty) {
        onTarget(fEmail, (dept) => {
          faculty['department'] = dept;
        });
      }
    }
  }
  for (const value of Object.values(node)) visit(value, depth + 1, onTarget);
}

export function collectFacultyEmails(body: unknown): string[] {
  const emails = new Set<string>();
  visit(body, 0, (email) => emails.add(email));
  return [...emails];
}

/** Mutates `body` in place; only emails present in `directory` (registered faculty WITH a profile department) change. */
export function applyFacultyDepartments(
  body: unknown,
  directory: Map<string, string>,
): void {
  if (!directory.size) return;
  visit(body, 0, (email, set) => {
    const dept = directory.get(email);
    if (dept) set(dept);
  });
}

export async function loadFacultyDepartmentDirectory(
  ds: Pick<DataSource, 'query'>,
  emails: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!emails.length) return out;
  const rows: Array<{ email: string; dept: string | null }> = await ds.query(
    `SELECT LOWER(TRIM(email)) AS email,
            COALESCE(NULLIF(TRIM(faculty_department), ''), NULLIF(TRIM(department), '')) AS dept
       FROM users
      WHERE role = 'faculty' AND LOWER(TRIM(email)) = ANY($1)`,
    [emails],
  );
  for (const row of rows) {
    if (row.dept) out.set(row.email, row.dept);
  }
  return out;
}

/** Best-effort: a lookup failure must never break the response. */
export async function alignFacultyDepartments(
  body: unknown,
  ds: Pick<DataSource, 'query'>,
): Promise<unknown> {
  try {
    const emails = collectFacultyEmails(body);
    if (!emails.length) return body;
    applyFacultyDepartments(
      body,
      await loadFacultyDepartmentDirectory(ds, emails),
    );
  } catch {
    /* keep the stored value */
  }
  return body;
}

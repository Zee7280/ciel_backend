import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import type { CsReportSnapshot } from './entities/cs-report-snapshot.entity';
import { CS_PROJECT_TYPE, periodLabel } from './cs-reporting.util';

const ISSUER = 'CIEL PK';

/** Printed under every report so a reader knows exactly what was counted. */
export const CS_REPORT_DEFINITIONS = [
  'Completed project: a community service project with at least one report verified by CIEL PK, or a Quick Community Impact log given final approval by CIEL PK. The period filters on the date CIEL PK verified it.',
  'Verified hours: each student’s approved attendance on the project. A reporting student with no attendance sessions is credited the hours in their CIEL PK-verified report. Quick Community Impact hours are the student’s credited time on the approved log.',
  'Person-hours: the sum of every credited student’s verified hours. Students are counted once however many projects they joined.',
  'Hour tiers (16 / 32 / 48 hours) are CIEL PK’s engagement bands, applied to each student’s total within this report.',
  'Beneficiaries: as reported for each project. Where a project has several reports, the largest figure is used.',
  'This is a frozen snapshot: downloading it again gives the same figures even if records change later.',
];

function sourceLabel(source: string): string {
  if (source === 'structured') return `${CS_PROJECT_TYPE.structured}s only`;
  if (source === 'quick') return `${CS_PROJECT_TYPE.quick} only`;
  return 'All community service';
}

function metaRows(s: CsReportSnapshot): [string, string][] {
  return [
    ['Report ID', s.code],
    ['Prepared by', ISSUER],
    ['Prepared for', s.preparedFor || '—'],
    ['Reporting period', periodLabel(s.filters)],
    ['University', s.filters.university || 'All universities'],
    ['Project types', sourceLabel(s.filters.source)],
    [
      'Generated',
      `${new Date(s.createdAt).toLocaleString('en-GB', { timeZone: 'Asia/Karachi' })} PKT`,
    ],
  ];
}

function keyFigures(s: CsReportSnapshot): [string, number][] {
  const m = s.summary;
  return [
    ['Completed projects', m.projects],
    [`${CS_PROJECT_TYPE.structured}s`, m.structuredProjects],
    [`${CS_PROJECT_TYPE.quick} activities`, m.quickProjects],
    ['Students credited', m.students],
    ['Universities', m.universities],
    ['Verified person-hours', m.personHours],
    ['Beneficiaries reached', m.beneficiaries],
  ];
}

/* ------------------------------------------------------------------ Excel */

const PROJECT_COLUMNS: { header: string; key: string; width: number }[] = [
  { header: 'Project ID', key: 'ref', width: 14 },
  { header: 'Type', key: 'type', width: 26 },
  { header: 'Title', key: 'title', width: 40 },
  { header: 'Host organisation', key: 'host', width: 28 },
  { header: 'Partners', key: 'partners', width: 28 },
  { header: 'City', key: 'city', width: 16 },
  { header: 'Province', key: 'province', width: 20 },
  { header: 'SDGs', key: 'sdgs', width: 10 },
  { header: 'Start date', key: 'startDate', width: 12 },
  { header: 'End date', key: 'endDate', width: 12 },
  { header: 'Verified by CIEL PK on', key: 'verifiedOn', width: 14 },
  { header: 'Students credited', key: 'students', width: 10 },
  { header: 'Verified person-hours', key: 'personHours', width: 12 },
  { header: 'Beneficiaries', key: 'beneficiaries', width: 12 },
  { header: 'Universities', key: 'universities', width: 36 },
  { header: 'Faculty supervisor', key: 'faculty', width: 26 },
];

const STUDENT_COLUMNS: { header: string; key: string; width: number }[] = [
  { header: 'Student name', key: 'name', width: 26 },
  { header: 'University', key: 'university', width: 32 },
  { header: 'Programme / department', key: 'programme', width: 26 },
  { header: 'Batch / enrolment year', key: 'batch', width: 12 },
  { header: 'Roll / registration no.', key: 'rollNo', width: 18 },
  { header: 'Project ID', key: 'projectRef', width: 14 },
  { header: 'Project title', key: 'projectTitle', width: 36 },
  { header: 'Type', key: 'projectType', width: 26 },
  { header: 'Verified on', key: 'verifiedOn', width: 12 },
  { header: 'Verified hours (this project)', key: 'hours', width: 12 },
  { header: 'Hours source', key: 'hoursSource', width: 24 },
  { header: 'Total verified hours (report)', key: 'totalHours', width: 12 },
  { header: 'Hour tier', key: 'tier', width: 30 },
  { header: 'Certificate ID', key: 'certificateId', width: 30 },
  { header: 'Verify certificate', key: 'verifyUrl', width: 50 },
];

function styleHeader(row: ExcelJS.Row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.alignment = { vertical: 'middle', wrapText: true };
  row.eachCell((cell) => {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF0E7D74' },
    };
  });
}

function dataSheet(
  wb: ExcelJS.Workbook,
  name: string,
  columns: { header: string; key: string; width: number }[],
  rows: object[],
) {
  const ws = wb.addWorksheet(name, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  ws.columns = columns;
  styleHeader(ws.getRow(1));
  ws.getRow(1).height = 32;
  ws.addRows(rows);
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: columns.length },
  };
}

/** Writes a titled two-or-more column table; returns the next free row. */
function summaryTable(
  ws: ExcelJS.Worksheet,
  startRow: number,
  title: string,
  headers: string[],
  rows: (string | number)[][],
): number {
  ws.getCell(startRow, 1).value = title;
  ws.getCell(startRow, 1).font = { bold: true, size: 12 };
  const header = ws.getRow(startRow + 1);
  header.values = headers;
  styleHeader(header);
  rows.forEach((r, i) => {
    ws.getRow(startRow + 2 + i).values = r;
  });
  return startRow + 2 + rows.length + 1;
}

export async function csReportXlsx(s: CsReportSnapshot): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = ISSUER;
  wb.created = new Date(s.createdAt);

  const ws = wb.addWorksheet('Summary');
  ws.columns = [{ width: 40 }, { width: 18 }, { width: 18 }, { width: 18 }];
  ws.getCell('A1').value = 'Community Service Report';
  ws.getCell('A1').font = { bold: true, size: 16 };
  let row = 3;
  for (const [k, v] of metaRows(s)) {
    ws.getCell(row, 1).value = k;
    ws.getCell(row, 1).font = { bold: true };
    ws.getCell(row, 2).value = v;
    row += 1;
  }
  row += 1;
  row = summaryTable(
    ws,
    row,
    'Key figures',
    ['Measure', 'Value'],
    keyFigures(s),
  );
  const m = s.summary;
  row = summaryTable(
    ws,
    row,
    'By university',
    ['University', 'Students', 'Projects', 'Verified hours'],
    m.byUniversity.map((u) => [u.university, u.students, u.projects, u.hours]),
  );
  row = summaryTable(
    ws,
    row,
    'By province',
    ['Province', 'Projects', 'Verified hours'],
    m.byProvince.map((p) => [p.province, p.projects, p.hours]),
  );
  row = summaryTable(
    ws,
    row,
    'By SDG (a project with several SDGs counts under each)',
    ['SDG', 'Projects', 'Verified hours'],
    m.bySdg.map((g) => [`SDG ${g.sdg}`, g.projects, g.hours]),
  );
  row = summaryTable(
    ws,
    row,
    'Students by hour tier',
    ['Tier', 'Students'],
    m.byTier.map((t) => [t.label, t.students]),
  );
  ws.getCell(row, 1).value = 'Definitions';
  ws.getCell(row, 1).font = { bold: true, size: 12 };
  for (const d of CS_REPORT_DEFINITIONS) {
    row += 1;
    ws.mergeCells(row, 1, row, 4);
    const cell = ws.getCell(row, 1);
    cell.value = d;
    cell.alignment = { wrapText: true, vertical: 'top' };
    ws.getRow(row).height = 45;
  }

  dataSheet(wb, 'Projects', PROJECT_COLUMNS, s.projects);
  if (s.students) dataSheet(wb, 'Students', STUDENT_COLUMNS, s.students);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/* ------------------------------------------------------------------ PDF */

const PAGE_MARGIN = 50;
const ROW_H = 16;
const TEAL = '#0E7D74';

type Doc = InstanceType<typeof PDFDocument>;

function ensureRoom(doc: Doc, needed: number) {
  if (doc.y + needed > doc.page.height - PAGE_MARGIN - 20) doc.addPage();
}

function pdfTable(
  doc: Doc,
  title: string,
  headers: string[],
  widths: number[],
  rows: (string | number)[][],
) {
  ensureRoom(doc, ROW_H * 3 + 18);
  doc.moveDown(0.6);
  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor('#000')
    .text(title, PAGE_MARGIN);
  doc.moveDown(0.3);
  const drawRow = (cells: (string | number)[], header: boolean) => {
    const page = doc.page;
    ensureRoom(doc, ROW_H);
    // A table that runs onto a new page repeats its header there.
    if (!header && doc.page !== page) drawRow(headers, true);
    const y = doc.y;
    if (header) {
      doc
        .rect(
          PAGE_MARGIN,
          y - 2,
          widths.reduce((a, b) => a + b, 0),
          ROW_H,
        )
        .fill(TEAL);
    }
    let x = PAGE_MARGIN;
    doc.font(header ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
    doc.fillColor(header ? '#FFF' : '#000');
    cells.forEach((c, i) => {
      doc.text(String(c), x + 4, y + 2, {
        width: widths[i] - 8,
        height: ROW_H,
        ellipsis: true,
        lineBreak: false,
        align: i === 0 ? 'left' : 'right',
      });
      x += widths[i];
    });
    doc.x = PAGE_MARGIN;
    doc.y = y + ROW_H;
  };
  drawRow(headers, true);
  if (!rows.length) drawRow(['None', ...headers.slice(1).map(() => '')], false);
  for (const r of rows) drawRow(r, false);
}

/**
 * At most `max` rows; the rest are added up into one "Others" row. Only the `summed` columns are
 * added; the others show a dash, since e.g. a project shared by two universities would count twice.
 */
function topRows(
  rows: (string | number)[][],
  max: number,
  label: string,
  summed: number[],
): (string | number)[][] {
  if (rows.length <= max) return rows;
  const rest = rows.slice(max - 1);
  const others = rest[0].map((_, i) => {
    if (i === 0) return `${label} (${rest.length})`;
    if (!summed.includes(i)) return '—';
    return (
      Math.round(rest.reduce((a, r) => a + Number(r[i] || 0), 0) * 10) / 10
    );
  });
  return [...rows.slice(0, max - 1), others];
}

export function csReportPdf(s: CsReportSnapshot): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: PAGE_MARGIN,
    bufferPages: true,
    info: { Title: `Community Service Report ${s.code}`, Author: ISSUER },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const full = doc.page.width - PAGE_MARGIN * 2;
  doc
    .font('Helvetica-Bold')
    .fontSize(18)
    .fillColor(TEAL)
    .text('Community Service Report');
  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor('#444')
    .text(`${ISSUER} · ${s.code}`);
  doc.moveDown(0.8);
  for (const [k, v] of metaRows(s)) {
    doc
      .font('Helvetica-Bold')
      .fontSize(9.5)
      .fillColor('#000')
      .text(`${k}: `, { continued: true });
    doc.font('Helvetica').text(v);
  }

  pdfTable(
    doc,
    'Key figures',
    ['Measure', 'Value'],
    [full * 0.7, full * 0.3],
    keyFigures(s),
  );
  const m = s.summary;
  pdfTable(
    doc,
    'By university',
    ['University', 'Students', 'Projects', 'Hours'],
    [full * 0.55, full * 0.15, full * 0.15, full * 0.15],
    topRows(
      m.byUniversity.map((u) => [
        u.university,
        u.students,
        u.projects,
        u.hours,
      ]),
      12,
      'Other universities',
      [1, 3],
    ),
  );
  pdfTable(
    doc,
    'By province',
    ['Province', 'Projects', 'Hours'],
    [full * 0.6, full * 0.2, full * 0.2],
    m.byProvince.map((p) => [p.province, p.projects, p.hours]),
  );
  pdfTable(
    doc,
    'By SDG (a project with several SDGs counts under each)',
    ['SDG', 'Projects', 'Hours'],
    [full * 0.6, full * 0.2, full * 0.2],
    m.bySdg.map((g) => [`SDG ${g.sdg}`, g.projects, g.hours]),
  );
  pdfTable(
    doc,
    'Students by hour tier',
    ['Tier', 'Students'],
    [full * 0.7, full * 0.3],
    m.byTier.map((t) => [t.label, t.students]),
  );

  ensureRoom(doc, 120);
  doc.moveDown(0.8);
  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor('#000')
    .text('Definitions', PAGE_MARGIN);
  doc.font('Helvetica').fontSize(8.5).fillColor('#333');
  for (const d of CS_REPORT_DEFINITIONS) {
    doc.moveDown(0.25).text(`• ${d}`, { width: full });
  }
  doc
    .moveDown(0.5)
    .text(
      s.students
        ? 'The project list and the named student list are in the accompanying Excel file.'
        : 'The project list is in the accompanying Excel file.',
      { width: full },
    );

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    // The footer sits in the bottom margin; without this pdfkit would start a new page for it.
    doc.page.margins.bottom = 0;
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#777')
      .text(
        `${ISSUER} · Community Service Report ${s.code} · Page ${i + 1} of ${range.count}`,
        PAGE_MARGIN,
        doc.page.height - PAGE_MARGIN + 15,
        { width: full, align: 'center', lineBreak: false },
      );
  }
  doc.end();
  return done;
}

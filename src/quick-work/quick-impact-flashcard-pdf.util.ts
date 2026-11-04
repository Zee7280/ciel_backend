import PDFDocument from 'pdfkit';
import type { PartnerImpactFacts } from './quick-impact-partner.util';

const BLUE_DARK = '#0d4f87';
const BLUE = '#1882c8';
const SOFT = '#eaf4ff';
const LINE = '#c9def3';
const INK = '#16313d';
const MUTED = '#536d81';

const M = 42; // page margin
const W = 595.28 - M * 2; // A4 content width

/**
 * One-page Quick Community Impact flashcard for the host / partner organisation. It carries the
 * activity and its totals only: no student names, contacts or evidence files.
 */
export function quickImpactFlashcardPdf(
  facts: PartnerImpactFacts,
  opts: { partnerName?: string } = {},
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: M,
    info: {
      Title: `Quick Community Impact flashcard: ${facts.title}`.slice(0, 200),
      Author: 'CIEL PK',
    },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  // Hero band
  doc.rect(0, 0, 595.28, 150).fill(BLUE_DARK);
  doc.rect(0, 118, 595.28, 32).fill(BLUE);
  doc
    .fillColor('#ffffff')
    .font('Helvetica-Bold')
    .fontSize(9)
    .text('CIEL PK  ·  QUICK COMMUNITY IMPACT', M, 34, {
      characterSpacing: 1.4,
    });
  doc
    .font('Helvetica-Bold')
    .fontSize(22)
    .text(facts.title, M, 52, { width: W, height: 60, ellipsis: true });
  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor('#ffffff')
    .text([facts.activityType, facts.date, facts.venue].join('  ·  '), M, 127, {
      width: W,
      height: 14,
      ellipsis: true,
    });

  // Metrics
  const metrics: [string, string][] = [
    ['Verified hours', `${facts.hours} h`],
    ['Students', String(facts.students)],
    [
      'People reached',
      facts.peopleReached === null ? '-' : String(facts.peopleReached),
    ],
    ['Evidence items', String(facts.evidenceCount)],
  ];
  const gap = 10;
  const bw = (W - gap * 3) / 4;
  let y = 172;
  metrics.forEach(([label, value], i) => {
    const x = M + i * (bw + gap);
    doc.roundedRect(x, y, bw, 58, 8).fillAndStroke(SOFT, LINE);
    doc
      .fillColor(BLUE_DARK)
      .font('Helvetica-Bold')
      .fontSize(19)
      .text(value, x + 10, y + 10, { width: bw - 20 });
    doc
      .fillColor(MUTED)
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .text(label.toUpperCase(), x + 10, y + 38, {
        width: bw - 20,
        characterSpacing: 0.6,
      });
  });
  y += 76;

  // SDG
  doc.roundedRect(M, y, W, 52, 8).fillAndStroke('#f5f9fc', '#e0eaf2');
  doc.roundedRect(M + 8, y + 6, 40, 40, 6).fill(facts.sdgColor ?? '#607d8b');
  doc
    .fillColor('#ffffff')
    .font('Helvetica-Bold')
    .fontSize(18)
    .text(facts.sdg ? String(facts.sdg) : '-', M + 8, y + 17, {
      width: 40,
      align: 'center',
    });
  doc
    .fillColor(INK)
    .font('Helvetica-Bold')
    .fontSize(11)
    .text(facts.sdgName ?? 'SDG not selected', M + 58, y + 12, {
      width: W - 70,
    });
  doc
    .fillColor(MUTED)
    .font('Helvetica')
    .fontSize(8.5)
    .text(
      facts.sdgName
        ? 'United Nations Sustainable Development Goal'
        : 'No goal was chosen for this activity',
      M + 58,
      y + 30,
      { width: W - 70 },
    );
  y += 70;

  // Reach against target
  if (facts.peopleTarget && facts.peopleTarget > 0) {
    const reached = facts.peopleReached ?? 0;
    const rate = Math.round((reached / facts.peopleTarget) * 100);
    doc
      .fillColor(MUTED)
      .font('Helvetica-Bold')
      .fontSize(8.5)
      .text('REACH AGAINST TARGET', M, y, { characterSpacing: 0.8 });
    doc
      .fillColor(INK)
      .font('Helvetica-Bold')
      .fontSize(10)
      .text(
        `${reached} of ${facts.peopleTarget} people reached  ·  ${rate}%`,
        M,
        y + 14,
      );
    doc.roundedRect(M, y + 32, W, 6, 3).fill('#dceaf6');
    doc
      .roundedRect(
        M,
        y + 32,
        Math.max(4, (W * Math.min(100, rate)) / 100),
        6,
        3,
      )
      .fill('#2182c6');
    y += 54;
  }

  // Activity description
  doc
    .fillColor(MUTED)
    .font('Helvetica-Bold')
    .fontSize(8.5)
    .text('WHAT HAPPENED', M, y, { characterSpacing: 0.8 });
  doc
    .fillColor(INK)
    .font('Helvetica')
    .fontSize(10.5)
    .text(facts.summary || 'No activity summary was added.', M, y + 14, {
      width: W,
      height: 220,
      ellipsis: true,
      lineGap: 2,
    });

  // Host / partners
  // Directly under the description (never past the footer).
  const hostY = Math.min(doc.y + 26, 690);
  const hosts = [facts.host, ...facts.partners].filter(Boolean).join('  ·  ');
  doc
    .fillColor(MUTED)
    .font('Helvetica-Bold')
    .fontSize(8.5)
    .text('HOST / PARTNERS', M, hostY, { characterSpacing: 0.8 });
  doc
    .fillColor(INK)
    .font('Helvetica')
    .fontSize(10)
    .text(hosts || 'Not recorded', M, hostY + 14, { width: W, height: 28 });

  // Footer
  doc
    .moveTo(M, 760)
    .lineTo(M + W, 760)
    .strokeColor(LINE)
    .stroke();
  doc
    .fillColor(MUTED)
    .font('Helvetica')
    .fontSize(8.5)
    .text(
      `${opts.partnerName ? `Prepared for ${opts.partnerName}  ·  ` : ''}Faculty verified  ·  CIEL PK final approval`,
      M,
      770,
      { width: W * 0.7, height: 12, ellipsis: true },
    );
  doc.text(`Ref ${facts.id.slice(0, 8).toUpperCase()}`, M, 770, {
    width: W,
    align: 'right',
  });

  doc.end();
  return done;
}

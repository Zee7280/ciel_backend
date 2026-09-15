import { BadRequestException } from '@nestjs/common';
import { assertStudentReportUploadMeta } from './student-report-file-upload';

const SHOULD_ACCEPT = [
  ['report.pdf', 'application/pdf'],
  ['essay.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['data.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['sheet.csv', 'text/csv'],
  ['photo.jpg', 'image/jpeg'],
  ['photo.gif', 'image/gif'],
  ['survey.zip', 'application/zip'],
  ['board.psd', 'application/octet-stream'],
  ['notes.txt', 'text/plain'],
  ['clip.mp4', 'video/mp4'],
  ['model.stl', 'application/octet-stream'],
] as const;

const SHOULD_BLOCK = [
  ['page.html', 'text/html'],
  ['run.exe', 'application/octet-stream'],
  ['hook.js', 'application/javascript'],
  ['icon.svg', 'image/svg+xml'],
] as const;

describe('assertStudentReportUploadMeta', () => {
  it.each(SHOULD_ACCEPT)('accepts supporting file %s', (filename, contentType) => {
    expect(() => assertStudentReportUploadMeta({ filename, contentType, size: 2048 })).not.toThrow();
  });

  it.each(SHOULD_BLOCK)('blocks dangerous file %s', (filename, contentType) => {
    expect(() => assertStudentReportUploadMeta({ filename, contentType, size: 2048 })).toThrow(
      BadRequestException,
    );
  });
});

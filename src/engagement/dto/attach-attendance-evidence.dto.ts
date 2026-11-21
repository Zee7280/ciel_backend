import { IsString, MaxLength } from 'class-validator';

/** PATCH :id/attendance/:logId/evidence — the https URL returned by the presigned upload. */
export class AttachAttendanceEvidenceDto {
  @IsString()
  @MaxLength(2048)
  evidenceUrl: string;
}

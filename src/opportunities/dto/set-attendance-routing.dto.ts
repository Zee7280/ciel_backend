import { IsIn } from 'class-validator';

export class SetAttendanceRoutingDto {
  @IsIn(['auto', 'partner', 'faculty'])
  override: 'auto' | 'partner' | 'faculty';
}

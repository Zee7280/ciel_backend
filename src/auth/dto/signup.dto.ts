import { IsIn } from 'class-validator';
import { OmitType } from '@nestjs/mapped-types';
import { CreateUserDto } from '../../users/dto/create-user.dto';
import { UserRole } from '../../users/enums/user-role.enum';
import { PUBLIC_SIGNUP_ROLES } from '../org-signup.util';

export class SignupDto extends OmitType(CreateUserDto, ['role'] as const) {
    @IsIn([...PUBLIC_SIGNUP_ROLES], { message: 'Invalid account type' })
    role: UserRole;
}

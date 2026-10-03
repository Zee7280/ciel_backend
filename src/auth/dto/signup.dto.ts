import { Equals, IsIn } from 'class-validator';
import { OmitType } from '@nestjs/mapped-types';
import { CreateUserDto } from '../../users/dto/create-user.dto';
import { UserRole } from '../../users/enums/user-role.enum';
import { PUBLIC_SIGNUP_ROLES } from '../org-signup.util';

export class SignupDto extends OmitType(CreateUserDto, ['role'] as const) {
    @IsIn([...PUBLIC_SIGNUP_ROLES], { message: 'Invalid account type' })
    role: UserRole;

    /** Terms + privacy consent. The form blocks submit without it; this makes the API refuse it too. */
    @Equals(true, { message: 'You must accept the Terms and Privacy Policy to create an account.' })
    acceptedTerms: boolean;
}

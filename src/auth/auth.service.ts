import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { Organization } from '../organizations/entities/organization.entity';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
    constructor(
        private usersService: UsersService,
        private jwtService: JwtService,
        private organizationsService: OrganizationsService,
    ) { }

    async signup(signupDto: SignupDto) {
        try {
            console.log('Signup payload:', signupDto);
            const { password, email, ...userData } = signupDto;

            // Check if user already exists
            const existingUser = await this.usersService.findByEmail(email);
            if (existingUser) {
                throw new ConflictException('Email already exists');
            }

            const hashedPassword = await bcrypt.hash(password, 10);

            let organization: Organization | null = null;
            if (userData.orgName && userData.orgType) {
                organization = await this.organizationsService.create({
                    name: userData.orgName,
                    orgType: userData.orgType,
                });
            }

            const user = await this.usersService.create({
                ...userData,
                email,
                password: hashedPassword,
                organization: organization // Link the org
            });
            return {
                message: 'User created successfully',
                user: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    role: user.role,
                    organizationId: organization?.id,
                    phone: user.phone,
                    cnic: user.cnic,
                    countryCode: user.countryCode
                },
            };
        } catch (error) {
            console.error('Signup error:', error);

            // Handle duplicate email error from database
            if (error.code === '23505') {
                throw new ConflictException('Email already exists');
            }

            throw error;
        }
    }

    async login(loginDto: LoginDto) {
        const { email, password } = loginDto;
        const user = await this.usersService.findByEmail(email);

        if (!user) {
            throw new UnauthorizedException('Invalid credentials');
        }

        if (user.status !== 'active' && user.status !== 'approved') {
            throw new UnauthorizedException('Account is not active');
        }

        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            throw new UnauthorizedException('Invalid credentials');
        }

        const payload = { sub: user.id, email: user.email, role: user.role, organizationId: user.organization?.id };
        const expiresIn = loginDto.isMobile ? '30d' : '60m';

        return {
            access_token: this.jwtService.sign(payload, { expiresIn }),
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                institution: user.institution,
                department: user.department,
                orgName: user.orgName,
                orgType: user.orgType,
                contactPerson: user.contactPerson,
                phone: user.phone,
                cnic: user.cnic,
                countryCode: user.countryCode,
                organizationId: user.organization?.id
            }
        };
    }
}

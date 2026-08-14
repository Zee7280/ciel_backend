import { Injectable, NotFoundException, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { UserRole } from './enums/user-role.enum';
import * as bcrypt from 'bcrypt';
import { NotificationsService } from '../notifications/notifications.service';
import { OrganizationMembershipService } from '../organization-membership/organization-membership.service';
import { getProfileCompletionStatus } from './profile-completion.util';
import { decryptPasswordRecord, encryptPasswordRecord } from './password-record.util';

function digitsOnly(s: string): string {
    return s.replace(/\D/g, '');
}

/**
 * Build a single international string for clients that read `contact` (e.g. student profile).
 * Signup stores national digits in `phone` and dial code in `countryCode`; without this, UIs only see local digits.
 */
function composeContactFromUserPhone(
    countryCode: string | null | undefined,
    phone: string | null | undefined,
): string | null {
    const rawPhone = (phone ?? '').trim();
    if (!rawPhone) return null;
    if (rawPhone.startsWith('+')) return rawPhone;

    const cc = (countryCode ?? '').trim();
    const nationalDigits = digitsOnly(rawPhone);
    if (!nationalDigits) return null;
    if (!cc) return rawPhone;

    const dialDigits = digitsOnly(cc);
    if (!dialDigits) return rawPhone;
    if (nationalDigits.startsWith(dialDigits)) {
        return `+${nationalDigits}`;
    }
    return `+${dialDigits}${nationalDigits}`;
}

@Injectable()
export class UsersService {
    constructor(
        @InjectRepository(User)
        private usersRepository: Repository<User>,
        private readonly notificationsService: NotificationsService,
        private readonly organizationMembershipService: OrganizationMembershipService,
    ) { }

    async create(createUserDto: CreateUserDto): Promise<User> {
        let plainForRecord: string | null = null;
        if (createUserDto.password && !createUserDto.password.startsWith('$2b$')) {
            plainForRecord = createUserDto.password;
            createUserDto.password = await bcrypt.hash(createUserDto.password, 10);
        }
        const user = this.usersRepository.create(createUserDto);
        if (plainForRecord) {
            user.passwordRecord = encryptPasswordRecord(plainForRecord);
        }
        return this.usersRepository.save(user);
    }

    async formatUserResponse(user: User) {
        const notifications_count = await this.notificationsService.countUnread(user.id);
        const membershipFlags = await this.organizationMembershipService.getUiFlags(user);
        let roleTitle: string = user.role;
        // Simple mapping based on known roles
        if (user.role === UserRole.SUPER_ADMIN) roleTitle = 'Super Admin';
        else if (user.role === UserRole.STUDENT) roleTitle = 'Student'; // Capitalized for consistency
        else if (user.role === UserRole.ORGANIZATION_ADMIN) roleTitle = 'Organization Admin';
        else if (user.role === UserRole.FACULTY) roleTitle = 'Faculty';
        else if (user.role === UserRole.UNIVERSITY) roleTitle = 'University';
        else if (user.role === UserRole.NGO) roleTitle = 'NGO';
        else if (user.role === UserRole.CORPORATE) roleTitle = 'Corporate';

        return {
            id: user.id,
            name: user.name,
            email: user.email,
            account_status: user.status,
            role: user.role, // Raw role for logic
            roleTitle: roleTitle, // Display role
            type: user.role, // keeping for backward compatibility if frontend uses it
            avatar: user.avatar,
            phone: user.phone,
            contact: composeContactFromUserPhone(user.countryCode, user.phone),
            city: user.city,
            institution: user.institution,
            department: user.department,
            university: user.university,
            major: user.major,
            bio: user.bio,
            interests: user.interests,
            sdgPreferences: user.sdgPreferences,
            notifications_count,
            organizationId: user.organization?.id,
            orgName: user.orgName,
            orgType: user.orgType,
            contactPerson: user.contactPerson,
            cnic: user.cnic,
            countryCode: user.countryCode,
            joinedDate: user.createdAt,
            faculty_department: user.faculty_department,
            requires_cnic: user.requires_cnic,
            requires_profile_verification: user.requires_profile_verification,
            profile_verified: user.profile_verified,
            identity_verified: user.identity_verified,
            ...membershipFlags,
        };
    }

    async updateGenericProfile(userId: string, dto: any) {
        const user = await this.usersRepository.findOne({ where: { id: userId } });
        if (!user) {
            throw new NotFoundException('User not found');
        }

        // Filter and map fields
        if (dto.name) user.name = dto.name;
        if (dto.institution) user.institution = dto.institution;
        if (dto.university) user.university = dto.university;
        if (dto.city) user.city = dto.city;
        if (dto.phone) user.phone = dto.phone;
        if (dto.avatar) user.avatar = dto.avatar;
        if (dto.bio) user.bio = dto.bio;
        if (dto.department) user.department = dto.department;
        if (dto.faculty_department) user.faculty_department = dto.faculty_department;
        if (dto.requires_cnic !== undefined) user.requires_cnic = dto.requires_cnic;
        if (dto.requires_profile_verification !== undefined) user.requires_profile_verification = dto.requires_profile_verification;
        if (dto.profile_verified !== undefined) user.profile_verified = dto.profile_verified;
        if (dto.identity_verified !== undefined) user.identity_verified = dto.identity_verified;

        // Save
        const updatedUser = await this.usersRepository.save(user);

        const data = await this.formatUserResponse(updatedUser);
        return {
            success: true,
            message: 'Profile updated successfully!',
            data: {
                ...data,
                image: data.avatar,
                avatar_url: data.avatar,
            },
        };
    }

    async findByEmail(email: string): Promise<User | null> {
        return this.usersRepository.findOne({ where: { email }, relations: ['organization'] });
    }

    async findAll(): Promise<User[]> {
        return this.usersRepository.find();
    }

    /**
     * Admin user table: includes `organization` for the same name/phone fallbacks as opportunity profile checks,
     * plus `profile_complete` / `profile_missing_fields`. Omits password reset secrets from the payload.
     */
    async findAllForAdmin(options: {
        revealPasswordRecords?: boolean;
        page?: number;
        limit?: number;
        search?: string;
        role?: string;
    } = {}) {
        const revealPasswordRecords = options.revealPasswordRecords ?? false;
        // Pagination is opt-in via explicit page/limit — other admin screens (email composer,
        // faculty-university scope picker) call this endpoint expecting the full unpaginated list.
        const paginate = options.page != null || options.limit != null;
        const page = Math.max(1, Math.floor(options.page ?? 1));
        const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 20)));
        const search = options.search?.trim();
        const role = options.role?.trim();

        // Only the org fields getProfileCompletionStatus/the admin list actually read — the rest of
        // Organization's ~24 columns were being fetched and discarded on every single row.
        const qb = this.usersRepository
            .createQueryBuilder('user')
            .leftJoin('user.organization', 'organization')
            .addSelect(['organization.id', 'organization.name', 'organization.contactName', 'organization.contactPhone', 'organization.city'])
            .orderBy('user.createdAt', 'DESC');

        if (paginate) {
            qb.skip((page - 1) * limit).take(limit);
        }

        if (search) {
            qb.andWhere('(user.name ILIKE :search OR user.email ILIKE :search)', { search: `%${search}%` });
        }
        if (role && role !== 'all') {
            qb.andWhere('user.role = :role', { role });
        }
        if (revealPasswordRecords) {
            qb.addSelect('user.passwordRecord');
        }

        const [users, total] = await qb.getManyAndCount();
        const data = users.map((user) => {
            const { password: _pw, passwordResetToken: _prt, passwordResetExpiry: _pre, passwordRecord, ...rest } =
                user;
            const { profile_complete, profile_missing_fields } = getProfileCompletionStatus(user);
            return {
                ...rest,
                profile_complete,
                profile_missing_fields,
                ...(revealPasswordRecords
                    ? { stored_password: decryptPasswordRecord(passwordRecord) }
                    : {}),
            };
        });
        return paginate ? { data, total, page, limit } : { data, total, page: 1, limit: total };
    }

    async findOne(id: string): Promise<User | null> {
        return this.usersRepository.findOne({ where: { id }, relations: ['organization'] });
    }

    async update(id: string, updateUserDto: any): Promise<User> {
        const passwordBeingUpdated = !!(updateUserDto?.password);
        let passwordRecordPatch: string | undefined;
        if (updateUserDto.password && !updateUserDto.password.startsWith('$2b$')) {
            passwordRecordPatch = encryptPasswordRecord(updateUserDto.password);
            updateUserDto.password = await bcrypt.hash(updateUserDto.password, 10);
        }
        const patch = { ...updateUserDto };
        if (passwordRecordPatch) {
            patch.passwordRecord = passwordRecordPatch;
        }
        await this.usersRepository.update(id, patch);
        if (passwordBeingUpdated) {
            await this.usersRepository.increment({ id }, 'tokenVersion', 1);
        }
        const user = await this.findOne(id);
        if (!user) {
            throw new NotFoundException('User not found');
        }
        return user;
    }

    async remove(id: string): Promise<void> {
        await this.usersRepository.delete(id);
    }

    async getProfile(id: string) {
        if (!id) {
            throw new BadRequestException('User ID is required');
        }
        const user = await this.findOne(id);
        if (!user) {
            throw new NotFoundException('User not found');
        }

        return {
            success: true,
            data: await this.formatUserResponse(user),
        };
    }

    async changePassword(userId: string, changePasswordDto: any) {
        const { currentPassword, newPassword } = changePasswordDto;
        const user = await this.usersRepository.findOne({ where: { id: userId } });

        if (!user) {
            throw new NotFoundException('User not found');
        }

        // Verify current password (assuming we have one)
        // If user was created without password (e.g. social login), this might need adjustment
        if (user.password) {
            const isMatch = await bcrypt.compare(currentPassword, user.password);
            if (!isMatch) {
                throw new UnauthorizedException('Current password is incorrect');
            }
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        user.password = hashedPassword;
        user.passwordRecord = encryptPasswordRecord(newPassword);
        user.tokenVersion = (user.tokenVersion ?? 0) + 1;
        await this.usersRepository.save(user);

        return { success: true, message: 'Password changed successfully' };
    }
    async findOrganizationPrimaryUser(organizationId: string): Promise<User | null> {
        return this.usersRepository.findOne({
            where: { organization: { id: organizationId } },
            order: { createdAt: 'ASC' }
        });
    }

    async savePasswordResetToken(userId: string, token: string, expiry: Date): Promise<void> {
        await this.usersRepository.update(userId, {
            passwordResetToken: token,
            passwordResetExpiry: expiry
        });
    }

    async findByResetToken(token: string): Promise<User | null> {
        return this.usersRepository.findOne({
            where: { passwordResetToken: token }
        });
    }

    /** Backfill admin-visible password copy when user logs in (existing accounts before password_record existed). */
    async capturePasswordRecordFromLogin(userId: string, plainPassword: string): Promise<void> {
        const trimmed = String(plainPassword || '').trim();
        if (!trimmed) return;
        await this.usersRepository.update(userId, {
            passwordRecord: encryptPasswordRecord(trimmed),
        });
    }

    async updatePassword(userId: string, hashedPassword: string, plainPassword?: string): Promise<void> {
        const patch: Record<string, unknown> = {
            password: hashedPassword,
            passwordResetToken: null,
            passwordResetExpiry: null,
        };
        if (plainPassword) {
            patch.passwordRecord = encryptPasswordRecord(plainPassword);
        }
        await this.usersRepository.update(userId, patch);
        await this.usersRepository.increment({ id: userId }, 'tokenVersion', 1);
    }
}

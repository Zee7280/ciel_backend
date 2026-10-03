import {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { UserRole } from './enums/user-role.enum';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';

/** Reset tokens are stored hashed: a DB read must not hand out working reset links. */
export function hashResetToken(token: string): string {
  return createHash('sha256').update(String(token ?? '')).digest('hex');
}
import { NotificationsService } from '../notifications/notifications.service';
import { OrganizationMembershipService } from '../organization-membership/organization-membership.service';
import { getProfileCompletionStatus } from './profile-completion.util';
import { AdminCreateUserDto } from './dto/admin-create-user.dto';
import {
  canonicalizePhoneInput,
  normalizeE164Phone,
} from '../common/phone-e164.util';

/** Escape LIKE/ILIKE wildcards so admin search text is matched literally. */
export function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, '\\$&');
}

function normalizeEmail(email: unknown): string {
  return String(email ?? '')
    .trim()
    .toLowerCase();
}

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
  if (rawPhone.startsWith('+')) return normalizeE164Phone(rawPhone) || rawPhone;

  const cc = (countryCode ?? '').trim();
  const nationalDigits = digitsOnly(rawPhone);
  if (!nationalDigits) return null;
  if (!cc) return normalizeE164Phone(rawPhone) || rawPhone;

  const dialDigits = digitsOnly(cc);
  if (!dialDigits) return normalizeE164Phone(rawPhone) || rawPhone;
  return (
    normalizeE164Phone(
      nationalDigits.startsWith(dialDigits)
        ? `+${nationalDigits}`
        : rawPhone,
      `+${dialDigits}`,
    ) || `+${dialDigits}${nationalDigits}`
  );
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    private readonly notificationsService: NotificationsService,
    private readonly organizationMembershipService: OrganizationMembershipService,
  ) {}

  async create(
    createUserDto: (CreateUserDto | AdminCreateUserDto) & {
      settings?: Record<string, unknown>;
      termsAcceptedAt?: Date;
    },
  ): Promise<User> {
    if (createUserDto.email !== undefined) {
      createUserDto.email = normalizeEmail(createUserDto.email);
      const taken = await this.findByEmail(createUserDto.email);
      if (taken) {
        throw new ConflictException('Email already exists');
      }
    }
    if (createUserDto.password && !createUserDto.password.startsWith('$2b$')) {
      createUserDto.password = await bcrypt.hash(createUserDto.password, 10);
    }
    const user = this.usersRepository.create(createUserDto as any as User);
    try {
      return await this.usersRepository.save(user);
    } catch (err) {
      if ((err as { code?: string })?.code === '23505') {
        throw new ConflictException('Email already exists');
      }
      throw err;
    }
  }

  async formatUserResponse(user: User) {
    const [notifications_count, membershipFlags] = await Promise.all([
      this.notificationsService.countUnread(user.id),
      this.organizationMembershipService.getUiFlags(user),
    ]);
    let roleTitle: string = user.role;
    // Simple mapping based on known roles
    if (user.role === UserRole.SUPER_ADMIN) roleTitle = 'Super Admin';
    else if (user.role === UserRole.STUDENT)
      roleTitle = 'Student'; // Capitalized for consistency
    else if (user.role === UserRole.ORGANIZATION_ADMIN)
      roleTitle = 'Organization Admin';
    else if (user.role === UserRole.FACULTY) roleTitle = 'Faculty';
    else if (user.role === UserRole.UNIVERSITY) roleTitle = 'University';
    else if (user.role === UserRole.NGO) roleTitle = 'NGO';
    else if (user.role === UserRole.CORPORATE) roleTitle = 'Corporate';
    else if (user.role === UserRole.INVESTOR) roleTitle = 'Investor / VC';

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
      investor: user.settings?.investor ?? null,
      ...membershipFlags,
    };
  }

  async updateGenericProfile(
    userId: string,
    dto: any,
    options: { isAdminCaller?: boolean } = {},
  ) {
    // Verification/gating flags are admin-controlled — a self-service profile update must never
    // be able to mark itself verified or drop its own CNIC/verification requirements.
    const isAdminCaller = options.isAdminCaller === true;
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Filter and map fields
    if (dto.name) user.name = dto.name;
    if (dto.institution) user.institution = dto.institution;
    if (dto.university) user.university = dto.university;
    if (dto.city) user.city = dto.city;
    if (dto.phone) {
      const parsed = canonicalizePhoneInput(dto.phone, {
        required: true,
        requiredMessage: 'Enter a valid mobile number.',
      });
      if (parsed.error) throw new BadRequestException(parsed.error);
      user.phone = parsed.e164;
    }
    if (dto.avatar) user.avatar = dto.avatar;
    if (dto.bio) user.bio = dto.bio;
    if (dto.department) user.department = dto.department;
    if (dto.faculty_department)
      user.faculty_department = dto.faculty_department;
    if (dto.orgName) user.orgName = dto.orgName;
    if (dto.contactPerson) user.contactPerson = dto.contactPerson;
    if (
      user.role === UserRole.INVESTOR &&
      dto.investorHub &&
      typeof dto.investorHub === 'object'
    ) {
      const settings =
        user.settings && typeof user.settings === 'object'
          ? { ...user.settings }
          : {};
      const investor =
        settings.investor && typeof settings.investor === 'object'
          ? { ...settings.investor }
          : {};
      const prevHub =
        investor.hub && typeof investor.hub === 'object' ? investor.hub : {};
      const incoming = dto.investorHub as {
        savedIds?: unknown;
        interest?: unknown;
        intros?: unknown;
        activity?: unknown;
        deskMsgs?: unknown;
      };
      const savedIds = Array.isArray(incoming.savedIds)
        ? [
            ...new Set(
              incoming.savedIds.map((id) => String(id)).filter(Boolean),
            ),
          ].slice(0, 200)
        : Array.isArray(prevHub.savedIds)
          ? prevHub.savedIds
          : [];
      const stampHubRows = (rows: unknown, keepStatus: boolean) =>
        Array.isArray(rows)
          ? rows
              .filter((row) => row && typeof row === 'object')
              .slice(0, 200)
              .map((row) => {
                const r = row as Record<string, unknown>;
                return {
                  entryId: String(r.entryId || r.id || ''),
                  note: typeof r.note === 'string' ? r.note.slice(0, 2000) : '',
                  at:
                    typeof r.at === 'string' ? r.at : new Date().toISOString(),
                  ...(keepStatus ? { status: 'pending' } : {}),
                };
              })
              .filter((row) => row.entryId)
          : [];
      const stampActivity = (rows: unknown) =>
        Array.isArray(rows)
          ? rows
              .filter((row) => row && typeof row === 'object')
              .slice(0, 200)
              .map((row) => {
                const r = row as Record<string, unknown>;
                return {
                  when: String(r.when || '').slice(0, 80),
                  ev: String(r.ev || '').slice(0, 500),
                  v: String(r.v || '—').slice(0, 200),
                  vis: String(r.vis || 'CIEL PK').slice(0, 80),
                };
              })
              .filter((row) => row.ev)
          : [];
      const stampDesk = (rows: unknown) =>
        Array.isArray(rows)
          ? rows
              .filter((row) => row && typeof row === 'object')
              .slice(0, 100)
              .map((row) => {
                const r = row as Record<string, unknown>;
                const t =
                  r.t === 'me' || r.t === 'them' || r.t === 'sys' ? r.t : 'me';
                return {
                  t,
                  x: String(r.x || '').slice(0, 2000),
                  w: String(r.w || '').slice(0, 80),
                };
              })
              .filter((row) => row.x)
          : [];
      investor.hub = {
        savedIds,
        interest:
          incoming.interest !== undefined
            ? stampHubRows(incoming.interest, false)
            : prevHub.interest || [],
        intros:
          incoming.intros !== undefined
            ? stampHubRows(incoming.intros, true)
            : prevHub.intros || [],
        activity:
          incoming.activity !== undefined
            ? stampActivity(incoming.activity)
            : prevHub.activity || [],
        deskMsgs:
          incoming.deskMsgs !== undefined
            ? stampDesk(incoming.deskMsgs)
            : prevHub.deskMsgs || [],
      };
      user.settings = { ...settings, investor };
    }
    if (
      user.role === UserRole.INVESTOR &&
      dto.investorMandate &&
      typeof dto.investorMandate === 'object'
    ) {
      const settings =
        user.settings && typeof user.settings === 'object'
          ? { ...user.settings }
          : {};
      const investor =
        settings.investor && typeof settings.investor === 'object'
          ? { ...settings.investor }
          : {};
      const m = dto.investorMandate as Record<string, unknown>;
      const copyStr = (key: string) => {
        if (typeof m[key] === 'string')
          investor[key] = String(m[key]).slice(0, 500);
      };
      const copyArr = (key: string) => {
        if (Array.isArray(m[key])) {
          investor[key] = m[key]
            .map((x) => String(x))
            .filter(Boolean)
            .slice(0, 20);
        }
      };
      copyArr('preferredRounds');
      copyArr('preferredStages');
      copyArr('sectors');
      copyStr('typicalTicket');
      copyStr('geographicFocus');
      copyStr('dealsPerYear');
      copyStr('decisionTimeline');
      copyStr('leadFollow');
      copyStr('sdgInterests');
      copyStr('valueAdd');
      copyStr('investorType');
      copyStr('website');
      copyStr('linkedin');
      if (typeof m.screeningNotes === 'string')
        investor.screeningNotes = String(m.screeningNotes).slice(0, 2000);
      user.settings = { ...settings, investor };
    }
    if (isAdminCaller) {
      if (dto.requires_cnic !== undefined)
        user.requires_cnic = dto.requires_cnic;
      if (dto.requires_profile_verification !== undefined)
        user.requires_profile_verification = dto.requires_profile_verification;
      if (dto.profile_verified !== undefined)
        user.profile_verified = dto.profile_verified;
      if (dto.identity_verified !== undefined)
        user.identity_verified = dto.identity_verified;
    }

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
    const normalized = String(email || '')
      .trim()
      .toLowerCase();
    if (!normalized) return null;
    return this.usersRepository
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.organization', 'organization')
      .where('LOWER(user.email) = :email', { email: normalized })
      .getOne();
  }

  async findAll(): Promise<User[]> {
    return this.usersRepository.find();
  }

  /**
   * Admin user table: includes `organization` for the same name/phone fallbacks as opportunity profile checks,
   * plus `profile_complete` / `profile_missing_fields`. Omits password reset secrets from the payload.
   */
  async findAllForAdmin(
    options: {
      /** @deprecated Ignored — recoverable passwords are no longer stored or returned. */
      revealPasswordRecords?: boolean;
      page?: number;
      limit?: number;
      search?: string;
      role?: string;
      sortBy?: string;
      sortDir?: string;
    } = {},
  ) {
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
      .addSelect([
        'organization.id',
        'organization.name',
        'organization.contactName',
        'organization.contactPhone',
        'organization.city',
      ])
      .orderBy(
        {
          name: 'user.name',
          email: 'user.email',
          role: 'user.role',
          status: 'user.status',
          createdAt: 'user.createdAt',
        }[options.sortBy ?? ''] ?? 'user.createdAt',
        String(options.sortDir).toLowerCase() === 'asc' ? 'ASC' : 'DESC',
      )
      .addOrderBy('user.id', 'ASC');

    if (paginate) {
      qb.skip((page - 1) * limit).take(limit);
    }

    if (search) {
      qb.andWhere('(user.name ILIKE :search OR user.email ILIKE :search)', {
        search: `%${escapeLikePattern(search)}%`,
      });
    }
    if (role && role !== 'all') {
      qb.andWhere('user.role = :role', { role });
    }
    const [users, total] = await qb.getManyAndCount();
    const data = users.map((user) => {
      const {
        password: _pw,
        passwordResetToken: _prt,
        passwordResetExpiry: _pre,
        ...rest
      } = user;
      const { profile_complete, profile_missing_fields } =
        getProfileCompletionStatus(user);
      return {
        ...rest,
        profile_complete,
        profile_missing_fields,
      };
    });
    return paginate
      ? { data, total, page, limit }
      : { data, total, page: 1, limit: total };
  }

  async findOne(id: string): Promise<User | null> {
    return this.usersRepository.findOne({
      where: { id },
      relations: ['organization'],
    });
  }

  async update(
    id: string,
    updateUserDto: any,
    /** Acting admin's id (admin route only). When given, self role/status changes are blocked. */
    actorId?: string,
  ): Promise<User> {
    const passwordBeingUpdated = !!updateUserDto?.password;
    if (updateUserDto.password && !updateUserDto.password.startsWith('$2b$')) {
      updateUserDto.password = await bcrypt.hash(updateUserDto.password, 10);
    }
    const patch = { ...updateUserDto };
    // Never accept the deprecated plaintext-copy column from callers.
    delete patch.passwordRecord;

    const touchesAccess =
      patch.status !== undefined ||
      patch.role !== undefined ||
      patch.email !== undefined;
    const existing = touchesAccess
      ? await this.usersRepository.findOne({ where: { id } })
      : null;
    if (touchesAccess && !existing) {
      throw new NotFoundException('User not found');
    }

    if (patch.email !== undefined) {
      patch.email = normalizeEmail(patch.email);
      const taken = await this.findByEmail(patch.email);
      if (taken && taken.id !== id) {
        throw new ConflictException('Email already exists');
      }
    }

    const statusChanged =
      patch.status !== undefined && patch.status !== existing?.status;
    const roleChanged =
      patch.role !== undefined && patch.role !== existing?.role;
    if (actorId && actorId === id && (statusChanged || roleChanged)) {
      throw new BadRequestException(
        'You cannot change your own role or status.',
      );
    }

    if (patch.status === 'active' || patch.status === 'rejected') {
      if (existing?.role === UserRole.INVESTOR) {
        const settings =
          existing.settings && typeof existing.settings === 'object'
            ? { ...existing.settings }
            : {};
        const investor =
          settings.investor && typeof settings.investor === 'object'
            ? { ...settings.investor }
            : {};
        investor.kycStatus =
          patch.status === 'active' ? 'verified' : 'rejected';
        investor.verifiedAt =
          patch.status === 'active'
            ? new Date().toISOString()
            : investor.verifiedAt;
        patch.settings = { ...settings, investor };
      }
    }
    try {
      await this.usersRepository.update(id, patch);
    } catch (err) {
      if ((err as { code?: string })?.code === '23505') {
        throw new ConflictException('Email already exists');
      }
      throw err;
    }
    // A password, status or role change must invalidate sessions minted under the old values.
    if (passwordBeingUpdated || statusChanged || roleChanged) {
      await this.revokeSessions(id);
    }
    const user = await this.findOne(id);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  /** Invalidate every JWT issued to this user (JwtStrategy compares `tokenVersion`). */
  async revokeSessions(userId: string): Promise<void> {
    await this.usersRepository.increment({ id: userId }, 'tokenVersion', 1);
  }

  /** Invalidate every JWT for all users belonging to an organization (e.g. when it is blocked). */
  async revokeOrganizationSessions(organizationId: string): Promise<void> {
    await this.usersRepository
      .createQueryBuilder()
      .update(User)
      .set({ tokenVersion: () => '"tokenVersion" + 1' })
      .where('"organizationId" = :organizationId', { organizationId })
      .execute();
  }

  async remove(id: string, actorId?: string): Promise<void> {
    if (actorId && actorId === id) {
      throw new BadRequestException('You cannot delete your own account.');
    }
    const target = await this.usersRepository.findOne({ where: { id } });
    if (!target) {
      throw new NotFoundException('User not found');
    }
    if (target.role === UserRole.SUPER_ADMIN) {
      const admins = await this.usersRepository.count({
        where: { role: UserRole.SUPER_ADMIN },
      });
      if (admins <= 1) {
        throw new ConflictException('Cannot delete the last remaining admin.');
      }
    }
    try {
      await this.usersRepository.delete(id);
    } catch (err) {
      if ((err as { code?: string })?.code === '23503') {
        throw new ConflictException(
          'This user has linked records (projects, applications, reports, etc.) and cannot be deleted. Suspend the account instead.',
        );
      }
      throw err;
    }
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
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    await this.usersRepository.save(user);

    return { success: true, message: 'Password changed successfully' };
  }
  async findOrganizationPrimaryUser(
    organizationId: string,
  ): Promise<User | null> {
    return this.usersRepository.findOne({
      where: { organization: { id: organizationId } },
      order: { createdAt: 'ASC' },
    });
  }

  async savePasswordResetToken(
    userId: string,
    token: string,
    expiry: Date,
  ): Promise<void> {
    await this.usersRepository.update(userId, {
      passwordResetToken: hashResetToken(token),
      passwordResetExpiry: expiry,
    });
  }

  async findByResetToken(token: string): Promise<User | null> {
    if (typeof token !== 'string' || !token.trim()) return null;
    return this.usersRepository.findOne({
      where: { passwordResetToken: hashResetToken(token.trim()) },
    });
  }

  async updatePassword(
    userId: string,
    hashedPassword: string,
    _plainPassword?: string, // deprecated & ignored: plaintext is never persisted
  ): Promise<void> {
    const patch: Record<string, unknown> = {
      password: hashedPassword,
      passwordResetToken: null,
      passwordResetExpiry: null,
    };
    await this.usersRepository.update(userId, patch);
    await this.revokeSessions(userId);
  }
}

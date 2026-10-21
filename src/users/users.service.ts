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
import { normalizeUserRoleInput } from './user-role-input.util';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';

/** Reset tokens are stored hashed: a DB read must not hand out working reset links. */
export function hashResetToken(token: string): string {
  return createHash('sha256')
    .update(String(token ?? ''))
    .digest('hex');
}
import { NotificationsService } from '../notifications/notifications.service';
import { StudentSubscriptionService } from '../student-subscription/student-subscription.service';
import { OrganizationMembershipService } from '../organization-membership/organization-membership.service';
import { getProfileCompletionStatus } from './profile-completion.util';
import { AdminCreateUserDto } from './dto/admin-create-user.dto';
import {
  encryptPasswordRecord,
  decryptPasswordRecord,
} from './password-record.util';
import {
  canonicalizePhoneInput,
  normalizeE164Phone,
} from '../common/phone-e164.util';

/** Escape LIKE/ILIKE wildcards so admin search text is matched literally. */
export function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, '\\$&');
}

function parseAdminDateBoundary(
  raw: string | undefined,
  edge: 'start' | 'end',
): Date | null {
  const v = String(raw || '').trim();
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    if (edge === 'start') d.setHours(0, 0, 0, 0);
    else d.setHours(23, 59, 59, 999);
  }
  return d;
}

function normalizeEmail(email: string | null | undefined): string {
  return String(email ?? '')
    .trim()
    .toLowerCase();
}

function digitsOnly(s: string): string {
  return s.replace(/\D/g, '');
}

/** Plain-object view of a loosely typed JSON value (`{}` when it is not an object). */
type LooseObject = Record<string, unknown>;

function isLooseObject(value: unknown): value is LooseObject {
  return !!value && typeof value === 'object';
}

/** Shallow copy of `raw` when it is an object, otherwise an empty object. */
function cloneLooseObject(raw: unknown): LooseObject {
  return isLooseObject(raw) ? { ...raw } : {};
}

/** Same coercion as `String(value)`, spelled out so the type-checker can see each branch. */
function coerceToString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    typeof value === 'symbol' ||
    value === null ||
    value === undefined
  ) {
    return String(value);
  }
  return String(value as { toString(): string });
}

/** Copy of `obj` without `keys` — same result as object-rest destructuring. */
function omitKeys<T extends object, K extends keyof T>(
  obj: T,
  keys: readonly K[],
): Omit<T, K> {
  const copy: T = { ...obj };
  for (const key of keys) delete copy[key];
  return copy;
}

/** Fields a self-service / admin profile update may carry (extra keys are ignored). */
export interface GenericProfileUpdateInput {
  name?: string;
  institution?: string;
  university?: string;
  city?: string;
  phone?: string;
  avatar?: string;
  bio?: string;
  department?: string;
  faculty_department?: string;
  orgName?: string;
  contactPerson?: string;
  investorHub?: unknown;
  investorMandate?: unknown;
  requires_cnic?: boolean;
  requires_profile_verification?: boolean;
  profile_verified?: boolean;
  identity_verified?: boolean;
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

/** Loosely typed admin/user patch accepted by `update()` (callers pass partial user rows). */
type UserUpdatePatch = Partial<User> & { passwordRecord?: string | null };

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
      nationalDigits.startsWith(dialDigits) ? `+${nationalDigits}` : rawPhone,
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
    private readonly studentSubscriptionService: StudentSubscriptionService,
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
    let plainForRecord: string | null = null;
    if (createUserDto.password && !createUserDto.password.startsWith('$2b$')) {
      plainForRecord = createUserDto.password;
      createUserDto.password = await bcrypt.hash(createUserDto.password, 10);
    }
    const user = this.usersRepository.create(createUserDto as any as User);
    if (plainForRecord) {
      user.passwordRecord = encryptPasswordRecord(plainForRecord);
    }
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
    const [notifications_count, membershipFlags, subscriptionFlags] =
      await Promise.all([
        this.notificationsService.countUnread(user.id),
        this.organizationMembershipService.getUiFlags(user),
        this.studentSubscriptionService.getUiFlags(user),
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
      investor:
        (user.settings as LooseObject | null | undefined)?.investor ?? null,
      ...membershipFlags,
      ...subscriptionFlags,
    };
  }

  async updateGenericProfile(
    userId: string,
    dto: GenericProfileUpdateInput,
    options: { isAdminCaller?: boolean } = {},
  ) {
    // Verification/gating flags are admin-controlled — a self-service profile update must never
    // be able to mark itself verified or drop its own CNIC/verification requirements.
    const isAdminCaller = options.isAdminCaller === true;
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // A student picks university + programme once (signup or, if missing, the profile page);
    // after that only an admin may change them. Non-students and admins are unaffected.
    const studentIdentityLocked = (current: string | null | undefined) =>
      !isAdminCaller &&
      user.role === UserRole.STUDENT &&
      !!String(current ?? '').trim();

    // Filter and map fields
    if (dto.name) user.name = dto.name;
    if (dto.institution && !studentIdentityLocked(user.institution))
      user.institution = dto.institution;
    if (dto.university && !studentIdentityLocked(user.university))
      user.university = dto.university;
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
    if (dto.department && !studentIdentityLocked(user.department))
      user.department = dto.department;
    if (
      dto.faculty_department &&
      !studentIdentityLocked(user.faculty_department)
    )
      user.faculty_department = dto.faculty_department;
    if (dto.orgName) user.orgName = dto.orgName;
    if (dto.contactPerson) user.contactPerson = dto.contactPerson;
    if (
      user.role === UserRole.INVESTOR &&
      dto.investorHub &&
      typeof dto.investorHub === 'object'
    ) {
      const settings = cloneLooseObject(user.settings);
      const investor = cloneLooseObject(settings.investor);
      const prevHub: LooseObject = isLooseObject(investor.hub)
        ? investor.hub
        : {};
      const incoming = dto.investorHub as {
        savedIds?: unknown;
        interest?: unknown;
        intros?: unknown;
        activity?: unknown;
        deskMsgs?: unknown;
      };
      const savedIds: unknown[] = Array.isArray(incoming.savedIds)
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
                  entryId: coerceToString(r.entryId || r.id || ''),
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
                  when: coerceToString(r.when || '').slice(0, 80),
                  ev: coerceToString(r.ev || '').slice(0, 500),
                  v: coerceToString(r.v || '—').slice(0, 200),
                  vis: coerceToString(r.vis || 'CIEL PK').slice(0, 80),
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
                  x: coerceToString(r.x || '').slice(0, 2000),
                  w: coerceToString(r.w || '').slice(0, 80),
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
      const settings = cloneLooseObject(user.settings);
      const investor = cloneLooseObject(settings.investor);
      const m = dto.investorMandate as Record<string, unknown>;
      const copyStr = (key: string) => {
        const value = m[key];
        if (typeof value === 'string') investor[key] = value.slice(0, 500);
      };
      const copyArr = (key: string) => {
        const value = m[key];
        if (Array.isArray(value)) {
          investor[key] = value
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
        investor.screeningNotes = m.screeningNotes.slice(0, 2000);
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
      revealPasswordRecords?: boolean;
      page?: number;
      limit?: number;
      search?: string;
      role?: string;
      status?: string;
      profile?: string;
      joinedFrom?: string;
      joinedTo?: string;
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
    const role = normalizeUserRoleInput(options.role?.trim());
    const status = options.status?.trim();
    const profile = String(options.profile || '')
      .trim()
      .toLowerCase();
    const profileFilter =
      profile === 'complete' || profile === 'incomplete' ? profile : '';
    const revealPasswordRecords = options.revealPasswordRecords === true;
    const joinedFrom = parseAdminDateBoundary(options.joinedFrom, 'start');
    const joinedTo = parseAdminDateBoundary(options.joinedTo, 'end');

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

    if (revealPasswordRecords) {
      qb.addSelect('user.passwordRecord');
    }

    const applySqlPagination = paginate && !profileFilter;
    if (applySqlPagination) {
      qb.skip((page - 1) * limit).take(limit);
    }

    if (search) {
      qb.andWhere(
        '(user.name ILIKE :search OR user.email ILIKE :search OR user.university ILIKE :search OR user.institution ILIKE :search OR user.orgName ILIKE :search OR user.phone ILIKE :search)',
        { search: `%${escapeLikePattern(search)}%` },
      );
    }
    if (role && role !== 'all') {
      qb.andWhere('user.role = :role', { role });
    }
    if (status && status !== 'all') {
      qb.andWhere('user.status = :status', { status });
    }
    if (joinedFrom) {
      qb.andWhere('user.createdAt >= :joinedFrom', { joinedFrom });
    }
    if (joinedTo) {
      qb.andWhere('user.createdAt <= :joinedTo', { joinedTo });
    }
    const [users, sqlTotal] = await qb.getManyAndCount();
    const mapped = users.map((user) => {
      const { passwordRecord } = user;
      const rest = omitKeys(user, [
        'password',
        'passwordResetToken',
        'passwordResetExpiry',
        'passwordRecord',
      ]);
      const { profile_complete, profile_missing_fields } =
        getProfileCompletionStatus(user);
      return {
        ...rest,
        profile_complete,
        profile_missing_fields,
        ...(revealPasswordRecords
          ? { stored_password: decryptPasswordRecord(passwordRecord) }
          : {}),
      };
    });
    const filtered = profileFilter
      ? mapped.filter((row) =>
          profileFilter === 'complete'
            ? row.profile_complete === true
            : row.profile_complete === false,
        )
      : mapped;
    const total = profileFilter ? filtered.length : sqlTotal;
    const data = profileFilter
      ? paginate
        ? filtered.slice((page - 1) * limit, page * limit)
        : filtered
      : mapped;
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
    const input = updateUserDto as UserUpdatePatch;
    const passwordBeingUpdated = !!input?.password;
    let passwordRecordPatch: string | undefined;
    if (input.password && !input.password.startsWith('$2b$')) {
      passwordRecordPatch = encryptPasswordRecord(input.password);
      input.password = await bcrypt.hash(input.password, 10);
    }
    const patch: UserUpdatePatch = { ...input };
    if (passwordRecordPatch) {
      patch.passwordRecord = passwordRecordPatch;
    } else {
      delete patch.passwordRecord;
    }

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
        const settings = cloneLooseObject(existing.settings);
        const investor = cloneLooseObject(settings.investor);
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

  async changePassword(userId: string, changePasswordDto: ChangePasswordInput) {
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

  /** Backfill admin-visible password copy when the user logs in with a known password. */
  async capturePasswordRecordFromLogin(
    userId: string,
    plainPassword: string,
  ): Promise<void> {
    const trimmed = String(plainPassword || '').trim();
    if (!trimmed) return;
    await this.usersRepository.update(userId, {
      passwordRecord: encryptPasswordRecord(trimmed),
    });
  }

  async updatePassword(
    userId: string,
    hashedPassword: string,
    plainPassword?: string,
  ): Promise<void> {
    const patch: Record<string, unknown> = {
      password: hashedPassword,
      passwordResetToken: null,
      passwordResetExpiry: null,
    };
    if (plainPassword) {
      patch.passwordRecord = encryptPasswordRecord(plainPassword);
    }
    await this.usersRepository.update(userId, patch);
    await this.revokeSessions(userId);
  }
}

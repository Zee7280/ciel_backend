import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { resolveJwtSecret } from '../auth/jwt-secret.util';
import { composeSignupContactPhone } from '../auth/org-signup.util';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { decryptWithKey, encryptWithKey } from '../common/aes-gcm.util';
import { canonicalizePhoneInput } from '../common/phone-e164.util';
import { FacultyUniversityScopeService } from '../faculty-university-scope/faculty-university-scope.service';
import { MailService } from '../mail/mail.service';
import { Organization } from '../organizations/entities/organization.entity';
import { PlatformSettingsService } from '../settings/platform-settings.service';
import { StudentSubscriptionService } from '../student-subscription/student-subscription.service';
import { PENDING_SUBSCRIPTION_STATUS } from '../student-subscription/student-subscription.util';
import { CreateUserDto } from '../users/dto/create-user.dto';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/enums/user-role.enum';
import { UsersService } from '../users/users.service';
import {
  ActivateUniversitySsoDto,
  SsoCallbackQuery,
  SsoCompleteDto,
  SsoStartQuery,
  UpsertUniversitySsoDto,
} from './dto/university-sso.dto';
import { SsoLoginTicket } from './entities/sso-login-ticket.entity';
import { UniversitySso } from './entities/university-sso.entity';
import {
  assertHttpsUrl,
  buildAuthorizationUrl,
  createPkce,
  exchangeCode,
  fetchDiscovery,
  type IdTokenClaims,
  OidcError,
  randomToken,
  verifyIdToken,
} from './oidc.util';
import { deriveSsoKey, seal, unseal } from './sso-seal.util';
import {
  emailDomain,
  isGuid,
  isMicrosoftTenantId,
  normalizeDomain,
  SSO_PROVIDER_LABEL,
  SSO_SCOPE,
  SSO_SIGNUP_TTL_SECONDS,
  SSO_STATE_TTL_SECONDS,
  SSO_TEST_LINK_TTL_SECONDS,
  SSO_TICKET_TTL_SECONDS,
  ssoDiscoveryUrlFor,
} from './university-sso.constants';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Carried through the provider round trip inside the sealed `state` parameter. */
type StateData = {
  u: string; // organizationId
  n: string; // nonce
  v: string; // PKCE verifier
  next: string | null;
  m: boolean; // mobile session
  t: boolean; // admin test sign-in: verify the provider, issue no session
};

/** A verified identity with no CIEL account yet, waiting for the completion form. */
type SignupData = {
  u: string;
  iss: string;
  sub: string;
  email: string;
  name: string;
  m: boolean;
  next: string | null;
};

type TestLinkData = { u: string; by: string };

type IdentityCheck =
  | { ok: true; email: string; name: string }
  | { ok: false; code: string; message: string };

@Injectable()
export class UniversitySsoService {
  private readonly logger = new Logger(UniversitySsoService.name);
  private readonly sealKey: Buffer | null;

  constructor(
    @InjectRepository(UniversitySso)
    private readonly ssoRepo: Repository<UniversitySso>,
    @InjectRepository(SsoLoginTicket)
    private readonly ticketRepo: Repository<SsoLoginTicket>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Organization)
    private readonly orgRepo: Repository<Organization>,
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly universityScope: FacultyUniversityScopeService,
    private readonly studentSubscription: StudentSubscriptionService,
    private readonly platformSettings: PlatformSettingsService,
    private readonly auditLogs: AuditLogsService,
    private readonly configService: ConfigService,
    @Optional() private readonly mailService?: MailService,
  ) {
    // SSO_SECRETS_KEY when set; otherwise the JWT secret (rotating it means re-entering client
    // secrets and re-running in-flight sign-ins, which is acceptable for a rare event).
    const raw =
      (this.configService.get<string>('SSO_SECRETS_KEY') ?? '').trim() ||
      resolveJwtSecret(this.configService.get<string>('JWT_SECRET'));
    this.sealKey = raw ? deriveSsoKey(raw) : null;
  }

  /* ------------------------------------------------------------------ shared */

  private key(): Buffer {
    if (!this.sealKey) {
      throw new ServiceUnavailableException(
        'University SSO is not configured on this server (SSO_SECRETS_KEY / JWT_SECRET).',
      );
    }
    return this.sealKey;
  }

  private frontendUrl(): string {
    return (
      this.configService.get<string>('FRONTEND_URL') || 'https://cielpk.com'
    ).replace(/\/+$/, '');
  }

  /** The API origin the provider must redirect back to; `SSO_REDIRECT_BASE_URL` pins it when set. */
  apiBaseFor(req: Request): string {
    const override = (process.env.SSO_REDIRECT_BASE_URL ?? '')
      .trim()
      .replace(/\/+$/, '');
    if (override) return override;
    const first = (v: unknown) =>
      String(Array.isArray(v) ? v[0] : (v ?? ''))
        .split(',')[0]
        .trim();
    const proto =
      first(req.headers['x-forwarded-proto']) || req.protocol || 'https';
    const host =
      first(req.headers['x-forwarded-host']) || first(req.headers.host);
    return `${proto}://${host}/api/v1`;
  }

  redirectUriFor(req: Request): string {
    return `${this.apiBaseFor(req)}/auth/sso/callback`;
  }

  private sanitizeNext(next: string | null | undefined): string | null {
    const v = (next ?? '').trim();
    if (!v.startsWith('/') || v.startsWith('//') || v.includes('\\'))
      return null;
    return v.length <= 300 ? v : null;
  }

  private async loadRow(
    organizationId: string,
    withSecret: boolean,
  ): Promise<UniversitySso | null> {
    const qb = this.ssoRepo
      .createQueryBuilder('sso')
      .leftJoinAndSelect('sso.organization', 'org')
      .where('sso.organizationId = :organizationId', { organizationId });
    if (withSecret) qb.addSelect('sso.clientSecretEncrypted');
    return qb.getOne();
  }

  private discoveryUrl(row: UniversitySso): string {
    return ssoDiscoveryUrlFor(row.provider, row.issuer, row.tenantId);
  }

  private audit(
    action: string,
    details: Record<string, unknown>,
    actor?: { id?: string | null; email?: string | null },
  ): void {
    void this.auditLogs.recordMutation({
      action,
      user: actor?.id ?? null,
      user_email: actor?.email ?? null,
      target:
        typeof details.organizationId === 'string'
          ? details.organizationId
          : null,
      target_type: 'university_sso',
      details,
    });
  }

  /* ------------------------------------------------------------------ admin */

  private toAdminView(row: UniversitySso, redirectUri: string) {
    return {
      organizationId: row.organizationId,
      organizationName: row.organization?.name ?? '',
      status: row.status,
      provider: row.provider,
      providerLabel: SSO_PROVIDER_LABEL[row.provider],
      issuer: row.issuer,
      tenantId: row.tenantId,
      discoveryUrl: this.discoveryUrl(row),
      clientId: row.clientId,
      hasClientSecret: Boolean(row.clientSecretEncrypted),
      allowedDomains: row.allowedDomains ?? [],
      redirectUri,
      activatedAt: row.activatedAt,
      activatedByUserId: row.activatedByUserId,
      lastTestAt: row.lastTestAt,
      lastTestOk: row.lastTestOk,
      lastTestNote: row.lastTestNote,
      lastSignInAt: row.lastSignInAt,
      signInCount: row.signInCount,
      updatedAt: row.updatedAt,
    };
  }

  async listForAdmin(redirectUri: string) {
    const rows = await this.ssoRepo
      .createQueryBuilder('sso')
      .leftJoinAndSelect('sso.organization', 'org')
      .addSelect('sso.clientSecretEncrypted')
      .orderBy('org.name', 'ASC')
      .getMany();
    return {
      enabled: await this.platformSettings.isUniversitySsoEnabled(),
      redirectUri,
      universities: rows.map((r) => this.toAdminView(r, redirectUri)),
    };
  }

  async getForAdmin(organizationId: string, redirectUri: string) {
    const org = await this.orgRepo.findOne({ where: { id: organizationId } });
    if (!org) throw new NotFoundException('Organization not found');
    const row = await this.loadRow(organizationId, true);
    return {
      enabled: await this.platformSettings.isUniversitySsoEnabled(),
      organizationId: org.id,
      organizationName: org.name,
      isUniversity: this.universityScope.isUniversityOrganization(org),
      redirectUri,
      sso: row ? this.toAdminView(row, redirectUri) : null,
    };
  }

  async upsert(
    admin: { id: string },
    organizationId: string,
    dto: UpsertUniversitySsoDto,
    redirectUri: string,
  ) {
    const org = await this.orgRepo.findOne({ where: { id: organizationId } });
    if (!org) throw new NotFoundException('Organization not found');
    if (!this.universityScope.isUniversityOrganization(org)) {
      throw new BadRequestException(
        'Single sign-on is only available for university organizations.',
      );
    }

    const provider = dto.provider;
    const clientId = dto.clientId.trim();
    if (!clientId) throw new BadRequestException('Enter the client ID.');
    let issuer: string | null = null;
    let tenantId: string | null = null;
    if (provider === 'oidc') {
      issuer = (dto.issuer ?? '').trim().replace(/\/+$/, '');
      try {
        // https only (a local mock provider over http is allowed for development and tests).
        assertHttpsUrl(issuer, 'Issuer URL');
      } catch {
        throw new BadRequestException(
          'Enter the identity provider issuer URL (https://…).',
        );
      }
    } else if (provider === 'microsoft') {
      tenantId = (dto.tenantId ?? '').trim().toLowerCase();
      if (!isMicrosoftTenantId(tenantId)) {
        throw new BadRequestException(
          'Enter the university’s Microsoft Entra tenant ID (not common / organizations).',
        );
      }
    } else if (dto.tenantId?.trim()) {
      tenantId = normalizeDomain(dto.tenantId);
      if (!tenantId) {
        throw new BadRequestException(
          'The Google Workspace domain is not a valid domain.',
        );
      }
    }

    const allowedDomains: string[] = [];
    for (const raw of dto.allowedDomains) {
      const domain = normalizeDomain(raw);
      if (!domain) {
        throw new BadRequestException(`"${raw}" is not a valid email domain.`);
      }
      if (!allowedDomains.includes(domain)) allowedDomains.push(domain);
    }

    const existing = await this.loadRow(organizationId, true);
    const secret = (dto.clientSecret ?? '').trim();
    if (!existing?.clientSecretEncrypted && !secret) {
      throw new BadRequestException(
        'Enter the client secret from the identity provider.',
      );
    }

    const row =
      existing ??
      this.ssoRepo.create({
        organizationId,
        status: 'draft',
        signInCount: 0,
      });
    const identityChanged =
      !!existing &&
      (existing.provider !== provider ||
        existing.issuer !== issuer ||
        existing.tenantId !== tenantId ||
        existing.clientId !== clientId);
    row.provider = provider;
    row.issuer = issuer;
    row.tenantId = tenantId;
    row.clientId = clientId;
    row.allowedDomains = allowedDomains;
    if (secret) row.clientSecretEncrypted = encryptWithKey(this.key(), secret);
    if (identityChanged) {
      // A different provider or client is unverified: it must pass a test sign-in again.
      row.lastTestAt = null;
      row.lastTestOk = null;
      row.lastTestNote = 'Provider settings changed; run a test sign-in again.';
      if (row.status === 'active') row.status = 'draft';
    }
    // Validate reachability now so a typo is caught on save, not on a student's first sign-in.
    try {
      await fetchDiscovery(this.discoveryUrl(row));
    } catch (e) {
      throw new BadRequestException(
        e instanceof OidcError
          ? e.message
          : 'Could not read the identity provider’s discovery document.',
      );
    }
    const saved = await this.ssoRepo.save(row);
    this.audit(
      'UNIVERSITY_SSO_CONFIGURED',
      {
        organizationId,
        provider,
        clientId,
        allowedDomains,
        identityChanged,
        secretUpdated: Boolean(secret),
      },
      admin,
    );
    const fresh = (await this.loadRow(saved.organizationId, true))!;
    return this.toAdminView(fresh, redirectUri);
  }

  async activate(
    admin: { id: string },
    organizationId: string,
    dto: ActivateUniversitySsoDto,
    redirectUri: string,
  ) {
    const row = await this.loadRow(organizationId, true);
    if (!row) {
      throw new NotFoundException(
        'Configure single sign-on for this university first.',
      );
    }
    if (!row.clientSecretEncrypted) {
      throw new BadRequestException('Add the client secret before activating.');
    }
    if (row.lastTestOk !== true && dto.skipTest !== true) {
      throw new BadRequestException(
        'Run a successful test sign-in first (or activate with skipTest to override).',
      );
    }
    row.status = 'active';
    row.activatedAt = new Date();
    row.activatedByUserId = admin.id;
    await this.ssoRepo.save(row);
    this.audit(
      'UNIVERSITY_SSO_ACTIVATED',
      { organizationId, skipTest: dto.skipTest === true },
      admin,
    );
    return this.toAdminView(
      (await this.loadRow(organizationId, true))!,
      redirectUri,
    );
  }

  async disable(
    admin: { id: string },
    organizationId: string,
    redirectUri: string,
  ) {
    const row = await this.loadRow(organizationId, true);
    if (!row) throw new NotFoundException('No single sign-on configuration');
    row.status = 'disabled';
    await this.ssoRepo.save(row);
    this.audit('UNIVERSITY_SSO_DISABLED', { organizationId }, admin);
    return this.toAdminView(
      (await this.loadRow(organizationId, true))!,
      redirectUri,
    );
  }

  async remove(admin: { id: string }, organizationId: string) {
    const row = await this.loadRow(organizationId, false);
    if (!row) throw new NotFoundException('No single sign-on configuration');
    if (row.status === 'active') {
      throw new BadRequestException(
        'Disable single sign-on before removing its configuration.',
      );
    }
    await this.ssoRepo.delete({ organizationId });
    this.audit('UNIVERSITY_SSO_REMOVED', { organizationId }, admin);
    return { removed: true };
  }

  /** A link the university's IT contact opens to prove the provider is set up; issues no session. */
  async createTestLink(
    admin: { id: string },
    organizationId: string,
    apiBase: string,
  ) {
    const row = await this.loadRow(organizationId, true);
    if (!row) {
      throw new NotFoundException(
        'Configure single sign-on for this university first.',
      );
    }
    if (!row.clientSecretEncrypted) {
      throw new BadRequestException('Add the client secret before testing.');
    }
    const token = seal(
      this.key(),
      'test',
      { u: organizationId, by: admin.id } satisfies TestLinkData,
      SSO_TEST_LINK_TTL_SECONDS,
    );
    this.audit('UNIVERSITY_SSO_TEST_LINK', { organizationId }, admin);
    return {
      url: `${apiBase}/auth/sso/test?token=${encodeURIComponent(token)}`,
      expiresAt: new Date(Date.now() + SSO_TEST_LINK_TTL_SECONDS * 1000),
    };
  }

  /* ------------------------------------------------------------------ public flow */

  async listActiveForLogin() {
    if (!(await this.platformSettings.isUniversitySsoEnabled())) return [];
    const rows = await this.ssoRepo
      .createQueryBuilder('sso')
      .leftJoinAndSelect('sso.organization', 'org')
      .where('sso.status = :status', { status: 'active' })
      .orderBy('org.name', 'ASC')
      .getMany();
    return rows.map((r) => ({
      organizationId: r.organizationId,
      name: r.organization?.name ?? '',
      provider: r.provider,
      providerLabel: SSO_PROVIDER_LABEL[r.provider],
      domains: r.allowedDomains ?? [],
    }));
  }

  /** Where to send the browser to sign in with the university's provider. */
  async start(q: SsoStartQuery, redirectUri: string): Promise<string> {
    if (!(await this.platformSettings.isUniversitySsoEnabled())) {
      throw new NotFoundException('University sign-in is not enabled.');
    }
    const row = await this.loadRow(q.university, false);
    if (!row || row.status !== 'active') {
      throw new NotFoundException(
        'University sign-in is not available for this university.',
      );
    }
    return this.beginAuthorization(row, redirectUri, {
      next: this.sanitizeNext(q.next),
      mobile: q.mobile === '1' || q.mobile === 'true',
      test: false,
    });
  }

  async startTest(token: string, redirectUri: string): Promise<string> {
    const data = unseal<TestLinkData>(this.key(), 'test', token);
    if (!data) {
      throw new BadRequestException(
        'This test link is invalid or has expired.',
      );
    }
    const row = await this.loadRow(data.u, false);
    if (!row) throw new NotFoundException('No single sign-on configuration');
    return this.beginAuthorization(row, redirectUri, {
      next: null,
      mobile: false,
      test: true,
    });
  }

  private async beginAuthorization(
    row: UniversitySso,
    redirectUri: string,
    opts: { next: string | null; mobile: boolean; test: boolean },
  ): Promise<string> {
    const discovery = await fetchDiscovery(this.discoveryUrl(row));
    const pkce = createPkce();
    const nonce = randomToken(16);
    const state = seal(
      this.key(),
      'state',
      {
        u: row.organizationId,
        n: nonce,
        v: pkce.verifier,
        next: opts.next,
        m: opts.mobile,
        t: opts.test,
      } satisfies StateData,
      SSO_STATE_TTL_SECONDS,
    );
    const domains = row.allowedDomains ?? [];
    const extra: Record<string, string | undefined> = {};
    if (row.provider === 'google') {
      // Pre-selects the Workspace account; the hd claim is still verified on the way back.
      extra.hd =
        row.tenantId || (domains.length === 1 ? domains[0] : undefined);
    } else if (row.provider === 'microsoft' && domains.length === 1) {
      extra.domain_hint = domains[0];
    }
    return buildAuthorizationUrl(discovery, {
      clientId: row.clientId,
      redirectUri,
      state,
      nonce,
      codeChallenge: pkce.challenge,
      scope: SSO_SCOPE,
      extra,
    });
  }

  private failUrl(code: string, message: string): string {
    const qs = new URLSearchParams({ error: code, message });
    return `${this.frontendUrl()}/login/sso?${qs.toString()}`;
  }

  private async recordTest(
    row: UniversitySso,
    ok: boolean,
    note: string,
  ): Promise<void> {
    await this.ssoRepo.update(
      { id: row.id },
      {
        lastTestAt: new Date(),
        lastTestOk: ok,
        lastTestNote: note.slice(0, 300),
      },
    );
  }

  /** The provider sent the browser back: verify, resolve the account, hand out a ticket. Always a redirect URL. */
  async handleCallback(
    q: SsoCallbackQuery,
    redirectUri: string,
  ): Promise<string> {
    let row: UniversitySso | null = null;
    let state: StateData | null = null;
    try {
      state = unseal<StateData>(this.key(), 'state', q.state);
      if (!state) {
        return this.failUrl(
          'invalid_state',
          'This sign-in link has expired. Start again.',
        );
      }
      row = await this.loadRow(state.u, true);
      if (!row || !row.clientSecretEncrypted) {
        return this.failUrl(
          'not_enabled',
          'University sign-in is not available for this university.',
        );
      }
      const org = row.organization;

      if (q.error) {
        const detail = (q.error_description || q.error).slice(0, 200);
        if (state.t)
          await this.recordTest(row, false, `Provider error: ${detail}`);
        return this.failUrl(
          'idp_error',
          `The identity provider returned an error: ${detail}`,
        );
      }
      if (!state.t) {
        if (!(await this.platformSettings.isUniversitySsoEnabled())) {
          return this.failUrl(
            'not_enabled',
            'University sign-in is not enabled.',
          );
        }
        if (row.status !== 'active') {
          return this.failUrl(
            'not_enabled',
            'University sign-in is not active for this university.',
          );
        }
      }
      if (!q.code) {
        return this.failUrl(
          'invalid_state',
          'The identity provider sent no code.',
        );
      }

      let claims: IdTokenClaims;
      try {
        const discovery = await fetchDiscovery(this.discoveryUrl(row));
        const { id_token } = await exchangeCode(discovery, {
          clientId: row.clientId,
          clientSecret: decryptWithKey(this.key(), row.clientSecretEncrypted),
          code: q.code,
          redirectUri,
          codeVerifier: state.v,
        });
        claims = await verifyIdToken(id_token, {
          jwksUri: discovery.jwks_uri,
          issuer: discovery.issuer,
          clientId: row.clientId,
          nonce: state.n,
        });
      } catch (e) {
        const message =
          e instanceof OidcError ? e.message : 'Could not verify the sign-in.';
        if (state.t) await this.recordTest(row, false, message);
        this.logger.warn(`SSO callback failed for ${state.u}: ${message}`);
        return this.failUrl('idp_error', message);
      }

      const identity = this.checkIdentity(row, claims);
      if (!identity.ok) {
        if (state.t) await this.recordTest(row, false, identity.message);
        this.audit('UNIVERSITY_SSO_REFUSED', {
          organizationId: row.organizationId,
          code: identity.code,
          email: typeof claims.email === 'string' ? claims.email : null,
        });
        return this.failUrl(identity.code, identity.message);
      }

      if (state.t) {
        await this.recordTest(
          row,
          true,
          `Test sign-in succeeded as ${identity.email}`,
        );
        this.audit('UNIVERSITY_SSO_TEST_OK', {
          organizationId: row.organizationId,
          email: identity.email,
        });
        const qs = new URLSearchParams({
          test: 'ok',
          university: org?.name ?? '',
          email: identity.email,
        });
        return `${this.frontendUrl()}/login/sso?${qs.toString()}`;
      }

      // Account resolution: the provider's subject is authoritative, then the verified email.
      let user = await this.userRepo.findOne({
        where: { ssoIssuer: claims.iss, ssoSubject: claims.sub },
        relations: ['organization'],
      });
      if (user) {
        if (user.role !== UserRole.STUDENT) {
          return this.failUrl(
            'not_student',
            'This university sign-in is for student accounts. Sign in with your password instead.',
          );
        }
      } else {
        const byEmail = await this.usersService.findByEmail(identity.email);
        if (byEmail) {
          if (byEmail.role !== UserRole.STUDENT) {
            return this.failUrl(
              'not_student',
              'This email belongs to a CIEL PK account that is not a student account. Sign in with your password.',
            );
          }
          if (byEmail.ssoSubject) {
            return this.failUrl(
              'identity_conflict',
              'This account is already linked to a different university sign-in. Contact CIEL PK support.',
            );
          }
          const affiliated =
            await this.universityScope.studentBelongsToOrganization(byEmail, {
              id: org.id,
              name: org.name,
            });
          if (!affiliated) {
            return this.failUrl(
              'not_affiliated',
              `Your CIEL PK account is not registered as a student of ${org.name}. Sign in with your password and update your university, or contact CIEL PK support.`,
            );
          }
          try {
            const linked = await this.userRepo.update(
              { id: byEmail.id, ssoSubject: IsNull() },
              { ssoIssuer: claims.iss, ssoSubject: claims.sub },
            );
            if (!linked.affected) throw new Error('already linked');
          } catch {
            return this.failUrl(
              'identity_conflict',
              'This university identity is already linked to another account. Contact CIEL PK support.',
            );
          }
          this.audit(
            'UNIVERSITY_SSO_LINKED',
            { organizationId: row.organizationId, userId: byEmail.id },
            { id: byEmail.id, email: byEmail.email },
          );
          user = byEmail;
        } else {
          if (!(await this.platformSettings.isRegistrationAllowed())) {
            return this.failUrl(
              'signup_closed',
              'New registrations are temporarily closed.',
            );
          }
          const token = seal(
            this.key(),
            'signup',
            {
              u: row.organizationId,
              iss: claims.iss,
              sub: claims.sub,
              email: identity.email,
              name: identity.name,
              m: state.m,
              next: state.next,
            } satisfies SignupData,
            SSO_SIGNUP_TTL_SECONDS,
          );
          const qs = new URLSearchParams({
            signup: token,
            email: identity.email,
            name: identity.name,
            university: org?.name ?? '',
          });
          return `${this.frontendUrl()}/login/sso?${qs.toString()}`;
        }
      }

      const ticket = await this.issueTicket(user, row, state.m);
      const qs = new URLSearchParams({ ticket });
      if (state.next) qs.set('next', state.next);
      return `${this.frontendUrl()}/login/sso?${qs.toString()}`;
    } catch (e) {
      this.logger.error(
        `SSO callback error: ${(e as Error).message}`,
        (e as Error).stack,
      );
      if (row && state?.t) {
        await this.recordTest(
          row,
          false,
          'Server error during test sign-in',
        ).catch(() => undefined);
      }
      return this.failUrl('server_error', 'Sign-in failed. Please try again.');
    }
  }

  /** Email, verification and tenant rules per provider. */
  private checkIdentity(
    row: UniversitySso,
    claims: IdTokenClaims,
  ): IdentityCheck {
    const orgName = row.organization?.name ?? 'this university';
    const domains = row.allowedDomains ?? [];
    let email =
      typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
    if (
      !email &&
      row.provider === 'microsoft' &&
      typeof claims.preferred_username === 'string' &&
      claims.preferred_username.includes('@')
    ) {
      email = claims.preferred_username.trim().toLowerCase();
    }
    if (!email || !EMAIL_RE.test(email)) {
      return {
        ok: false,
        code: 'no_email',
        message: 'The identity provider did not share an email address.',
      };
    }
    const domain = emailDomain(email);
    if (!domains.includes(domain)) {
      return {
        ok: false,
        code: 'domain_not_allowed',
        message: `${domain} is not an approved email domain for ${orgName}. Sign in with your university email.`,
      };
    }
    const verified =
      claims.email_verified === true || claims.email_verified === 'true';
    if (row.provider === 'google') {
      if (!verified) {
        return {
          ok: false,
          code: 'email_not_verified',
          message: 'Your email address is not verified with Google.',
        };
      }
      const hd = typeof claims.hd === 'string' ? claims.hd.toLowerCase() : '';
      if (!hd || !domains.includes(hd)) {
        return {
          ok: false,
          code: 'not_workspace',
          message: `Sign in with your ${orgName} Google Workspace account, not a personal Google account.`,
        };
      }
    } else if (row.provider === 'microsoft') {
      // The issuer check already pinned the tenant; a GUID tenant id is compared as well.
      if (
        row.tenantId &&
        isGuid(row.tenantId) &&
        String(claims.tid ?? '').toLowerCase() !== row.tenantId
      ) {
        return {
          ok: false,
          code: 'wrong_tenant',
          message: `Sign in with your ${orgName} Microsoft 365 account.`,
        };
      }
    } else if (!verified) {
      return {
        ok: false,
        code: 'email_not_verified',
        message: 'Your email address is not verified with your university.',
      };
    }
    const name =
      (typeof claims.name === 'string' && claims.name.trim()) ||
      [claims.given_name, claims.family_name]
        .filter((v): v is string => typeof v === 'string' && !!v.trim())
        .join(' ')
        .trim();
    return { ok: true, email, name: name.slice(0, 100) };
  }

  private async issueTicket(
    user: User,
    row: UniversitySso,
    isMobile: boolean,
  ): Promise<string> {
    const token = randomToken(32);
    await this.ticketRepo.save(
      this.ticketRepo.create({
        tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
        userId: user.id,
        organizationId: row.organizationId,
        isMobile,
        expiresAt: new Date(Date.now() + SSO_TICKET_TTL_SECONDS * 1000),
      }),
    );
    return token;
  }

  /** Frontend trades the one-time ticket for a session (same shape as password login). */
  async exchange(ticket: string) {
    if (!(await this.platformSettings.isUniversitySsoEnabled())) {
      throw new UnauthorizedException('University sign-in is not enabled.');
    }
    const expired = new UnauthorizedException(
      'This sign-in link has expired. Start again.',
    );
    const hash = crypto.createHash('sha256').update(ticket).digest('hex');
    const row = await this.ticketRepo.findOne({ where: { tokenHash: hash } });
    if (!row || row.usedAt || row.expiresAt.getTime() < Date.now())
      throw expired;
    const claimed = await this.ticketRepo.update(
      { id: row.id, usedAt: IsNull() },
      { usedAt: new Date() },
    );
    if (!claimed.affected) throw expired;

    const user = await this.userRepo.findOne({
      where: { id: row.userId },
      relations: ['organization'],
    });
    if (!user || user.role !== UserRole.STUDENT) throw expired;
    await this.authService.assertLoginAllowed(user);
    const session = await this.authService.issueSession(user, row.isMobile);

    void this.ssoRepo
      .createQueryBuilder()
      .update(UniversitySso)
      .set({ lastSignInAt: new Date(), signInCount: () => '"signInCount" + 1' })
      .where('organizationId = :organizationId', {
        organizationId: row.organizationId,
      })
      .execute()
      .catch(() => undefined);
    void this.ticketRepo
      .delete({ expiresAt: LessThan(new Date(Date.now() - 60 * 60_000)) })
      .catch(() => undefined);
    this.audit(
      'UNIVERSITY_SSO_SIGN_IN',
      { organizationId: row.organizationId, userId: user.id },
      { id: user.id, email: user.email },
    );
    return { success: true, data: session };
  }

  /** First-time student: create the account from the verified identity plus the completion form. */
  async complete(dto: SsoCompleteDto) {
    const data = unseal<SignupData>(this.key(), 'signup', dto.token);
    if (!data) {
      throw new BadRequestException(
        'This sign-up link has expired. Start the university sign-in again.',
      );
    }
    if (!(await this.platformSettings.isUniversitySsoEnabled())) {
      throw new ForbiddenException('University sign-in is not enabled.');
    }
    const row = await this.loadRow(data.u, false);
    if (!row || row.status !== 'active' || !row.organization) {
      throw new ForbiddenException(
        'University sign-in is not active for this university.',
      );
    }
    if (!(await this.platformSettings.isRegistrationAllowed())) {
      throw new ForbiddenException('New registrations are temporarily closed.');
    }
    if (dto.acceptedTerms !== true) {
      throw new BadRequestException(
        'Accept the Terms and Privacy Policy to continue.',
      );
    }
    const department = dto.department.trim();
    if (!department) {
      throw new BadRequestException('Enter your department or programme.');
    }
    const phone = canonicalizePhoneInput(
      composeSignupContactPhone(dto.countryCode, dto.phone) || dto.phone,
      { required: true, requiredMessage: 'Enter a valid mobile number.' },
    );
    if (phone.error) throw new BadRequestException(phone.error);

    if (await this.usersService.findByEmail(data.email)) {
      throw new ConflictException(
        'An account with this email already exists. Sign in with your university account again to link it.',
      );
    }
    if (
      await this.userRepo.findOne({
        where: { ssoIssuer: data.iss, ssoSubject: data.sub },
      })
    ) {
      throw new ConflictException(
        'This university identity is already linked to an account.',
      );
    }

    const org = row.organization;
    const needsSubscription =
      await this.studentSubscription.studentNeedsSubscriptionAtSignup({
        role: UserRole.STUDENT,
        institution: org.name,
        university: org.name,
      });
    // No usable password: the account signs in through the university. Pre-hashed so no
    // recoverable password record is kept; "Forgot password" still lets the student set one.
    const password = await bcrypt.hash(randomToken(32), 10);
    const name = data.name || data.email.split('@')[0];
    const user = await this.usersService.create({
      name,
      email: data.email,
      password,
      role: UserRole.STUDENT,
      university: org.name,
      institution: org.name,
      department,
      phone: phone.e164,
      ...(dto.countryCode?.trim()
        ? { countryCode: dto.countryCode.trim() }
        : {}),
      ...(dto.registrationNumber?.trim()
        ? { registrationNumber: dto.registrationNumber.trim().slice(0, 60) }
        : {}),
      ...(dto.city?.trim() ? { city: dto.city.trim().slice(0, 80) } : {}),
      ...(needsSubscription ? { status: PENDING_SUBSCRIPTION_STATUS } : {}),
      ssoIssuer: data.iss,
      ssoSubject: data.sub,
      termsAcceptedAt: new Date(),
    } as CreateUserDto & {
      ssoIssuer: string;
      ssoSubject: string;
      termsAcceptedAt: Date;
    });
    try {
      await this.mailService?.sendWelcomeEmail(user.email, user.name);
    } catch (e) {
      this.logger.warn(`SSO welcome email failed: ${(e as Error).message}`);
    }
    const full = (await this.userRepo.findOne({
      where: { id: user.id },
      relations: ['organization'],
    }))!;
    await this.authService.assertLoginAllowed(full);
    const session = await this.authService.issueSession(full, data.m);
    this.audit(
      'UNIVERSITY_SSO_SIGNUP',
      { organizationId: row.organizationId, userId: user.id },
      { id: user.id, email: user.email },
    );
    return { success: true, data: { ...session, next: data.next } };
  }
}

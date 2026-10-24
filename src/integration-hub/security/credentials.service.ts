import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { ExternalCredential, ExternalPlatform } from '../entities';
import { HUB_CONNECTION } from '../hub-connection.constants';
import { HubSecretsService } from './hub-secrets.service';
import { HubAuditService, HubActor } from '../audit/hub-audit.service';

export type IssuedCredential = {
  id: string;
  keyId: string;
  /** Shown exactly once. */
  secret: string;
  label: string | null;
  expiresAt: Date | null;
};

export type CredentialView = Omit<ExternalCredential, 'secretCiphertext'>;

@Injectable()
export class CredentialsService {
  constructor(
    @InjectRepository(ExternalCredential, HUB_CONNECTION)
    private readonly repo: Repository<ExternalCredential>,
    @InjectRepository(ExternalPlatform, HUB_CONNECTION)
    private readonly platforms: Repository<ExternalPlatform>,
    private readonly secrets: HubSecretsService,
    private readonly audit: HubAuditService,
  ) {}

  private view(c: ExternalCredential): CredentialView {
    const { secretCiphertext: _omit, ...rest } = c;
    void _omit;
    return rest;
  }

  async listForPlatform(platformId: string): Promise<CredentialView[]> {
    const rows = await this.repo.find({
      where: { platformId },
      order: { createdAt: 'DESC' },
    });
    return rows.map((r) => this.view(r));
  }

  async issue(
    platformId: string,
    opts: { label?: string | null; expiresInDays?: number | null },
    actor: HubActor,
  ): Promise<IssuedCredential> {
    const platform = await this.platforms.findOne({
      where: { id: platformId },
    });
    if (!platform) throw new NotFoundException('Platform not found');
    if (platform.status === 'retired') {
      throw new BadRequestException(
        'Retired platforms cannot receive credentials',
      );
    }
    const active = await this.repo.count({
      where: { platformId, status: 'active' },
    });
    if (active >= 2) {
      throw new BadRequestException(
        'A platform may hold at most two active credentials (current + rotation). Revoke one first.',
      );
    }
    const keyId = `hk_${crypto.randomBytes(12).toString('hex')}`;
    const secret = crypto.randomBytes(32).toString('base64url');
    const expiresAt =
      opts.expiresInDays && opts.expiresInDays > 0
        ? new Date(Date.now() + opts.expiresInDays * 86_400_000)
        : null;
    const row = this.repo.create({
      platformId,
      keyId,
      secretCiphertext: this.secrets.encrypt(secret),
      secretLast4: secret.slice(-4),
      status: 'active',
      label: opts.label?.trim() || null,
      expiresAt,
      createdByUserId: actor.id ?? null,
    });
    await this.repo.save(row);
    await this.audit.log({
      actor,
      action: 'CREDENTIAL_ISSUED',
      targetType: 'credential',
      targetId: row.id,
      details: { platformId, keyId, label: row.label, expiresAt },
    });
    return { id: row.id, keyId, secret, label: row.label, expiresAt };
  }

  async revoke(
    platformId: string,
    credentialId: string,
    actor: HubActor,
  ): Promise<CredentialView> {
    const row = await this.repo.findOne({
      where: { id: credentialId, platformId },
    });
    if (!row) throw new NotFoundException('Credential not found');
    if (row.status === 'revoked') return this.view(row);
    row.status = 'revoked';
    row.revokedAt = new Date();
    row.revokedByUserId = actor.id ?? null;
    await this.repo.save(row);
    await this.audit.log({
      actor,
      action: 'CREDENTIAL_REVOKED',
      targetType: 'credential',
      targetId: row.id,
      details: { platformId, keyId: row.keyId },
    });
    return this.view(row);
  }

  /** Active, unexpired credential with its platform, and the decrypted secret for verification. */
  async resolveForAuth(keyId: string): Promise<{
    credential: ExternalCredential;
    platform: ExternalPlatform;
    secret: string;
  } | null> {
    const credential = await this.repo.findOne({
      where: { keyId, status: 'active' },
      relations: ['platform'],
    });
    if (!credential) return null;
    if (credential.expiresAt && credential.expiresAt.getTime() < Date.now()) {
      return null;
    }
    let secret: string;
    try {
      secret = this.secrets.decrypt(credential.secretCiphertext);
    } catch {
      return null;
    }
    return { credential, platform: credential.platform, secret };
  }

  /** Throttled "last used" stamp (at most once a minute per credential). */
  async touch(credential: ExternalCredential): Promise<void> {
    const last = credential.lastUsedAt?.getTime() ?? 0;
    if (Date.now() - last < 60_000) return;
    await this.repo.update({ id: credential.id }, { lastUsedAt: new Date() });
  }
}

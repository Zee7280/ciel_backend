import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import {
  ExternalConnection,
  ExternalEvidence,
  ExternalPlatform,
} from '../entities';
import { HUB_CONNECTION } from '../hub-connection.constants';
import {
  effectiveSettings,
  isUuid,
  parsePage,
  uuidFilter,
} from '../hub-common.util';
import { ConnectionsService } from '../platforms/connections.service';
import { HubStorageService } from './hub-storage.service';
import { HubActor, HubAuditService } from '../audit/hub-audit.service';

const TICKET_TTL_SECONDS = 15 * 60;
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};

export type UploadTicket = {
  upload_id: string;
  upload_url: string;
  method: 'PUT';
  headers: { 'Content-Type': string; 'Content-Length': string };
  expires_in_seconds: number;
};

/**
 * Evidence lifecycle (design §4.4): ticket → direct upload to quarantine → complete (validate,
 * hash, move to accepted) → referenced by an event. Bytes never pass through the app server.
 */
@Injectable()
export class EvidenceService {
  constructor(
    @InjectRepository(ExternalEvidence, HUB_CONNECTION)
    private readonly repo: Repository<ExternalEvidence>,
    private readonly storage: HubStorageService,
    private readonly connections: ConnectionsService,
    private readonly audit: HubAuditService,
  ) {}

  private requireStorage(): void {
    if (!this.storage.configured) {
      throw new ServiceUnavailableException({
        success: false,
        code: 'EVIDENCE_STORAGE_UNAVAILABLE',
        message: 'Evidence storage is not configured',
      });
    }
  }

  async issueTicket(
    platform: ExternalPlatform,
    input: {
      connection_id?: unknown;
      content_type?: unknown;
      size_bytes?: unknown;
      original_name?: unknown;
    },
  ): Promise<UploadTicket> {
    this.requireStorage();
    if (!isUuid(input.connection_id)) {
      throw new BadRequestException({
        success: false,
        code: 'CONNECTION_NOT_FOUND',
        message: 'connection_id must be a UUID',
      });
    }
    const conn = await this.connections.resolveForIntake(
      input.connection_id,
      platform.id,
    );
    if (!conn.ok) {
      throw new BadRequestException({
        success: false,
        code: conn.code,
        message: 'Connection cannot receive evidence',
      });
    }
    if (!conn.connection.scopes.includes('evidence.item')) {
      throw new BadRequestException({
        success: false,
        code: 'EVENT_TYPE_NOT_IN_SCOPE',
        message: 'evidence.item is not in scope for this connection',
      });
    }
    const settings = effectiveSettings(platform);
    const contentType = (
      typeof input.content_type === 'string' ? input.content_type : ''
    )
      .toLowerCase()
      .trim();
    if (!settings.evidence_mime_allowlist.includes(contentType)) {
      throw new BadRequestException({
        success: false,
        code: 'EVIDENCE_TYPE_NOT_ALLOWED',
        message: `content_type must be one of ${settings.evidence_mime_allowlist.join(', ')}`,
      });
    }
    const size = Number(input.size_bytes);
    if (
      !Number.isInteger(size) ||
      size <= 0 ||
      size > settings.max_evidence_bytes
    ) {
      throw new BadRequestException({
        success: false,
        code: 'EVIDENCE_TOO_LARGE',
        message: `size_bytes must be 1..${settings.max_evidence_bytes}`,
      });
    }
    const uploadId = crypto.randomUUID();
    const ext = EXT_BY_MIME[contentType] ?? '';
    const key = this.storage.quarantineKey(conn.connection.id, uploadId, ext);
    const uploadUrl = await this.storage.presignUpload({
      key,
      contentType,
      contentLength: size,
      expiresInSeconds: TICKET_TTL_SECONDS,
    });
    const originalName =
      typeof input.original_name === 'string'
        ? input.original_name.slice(0, 255)
        : null;
    await this.repo.save(
      this.repo.create({
        connectionId: conn.connection.id,
        platformId: platform.id,
        recordId: null,
        uploadId,
        bucket: this.storage.bucket,
        storageKey: key,
        originalName,
        mimeType: contentType,
        sizeBytes: String(size),
        sha256: null,
        state: 'quarantined',
        visibility: 'restricted',
        ticketExpiresAt: new Date(Date.now() + TICKET_TTL_SECONDS * 1000),
      }),
    );
    return {
      upload_id: uploadId,
      upload_url: uploadUrl,
      method: 'PUT',
      headers: { 'Content-Type': contentType, 'Content-Length': String(size) },
      expires_in_seconds: TICKET_TTL_SECONDS,
    };
  }

  /** Vendor signals the PUT finished: validate the object, hash it, move it out of quarantine. */
  async complete(
    platform: ExternalPlatform,
    uploadId: string,
    declaredSha256?: unknown,
  ): Promise<{
    evidence_id: string;
    upload_id: string;
    state: string;
    sha256: string | null;
  }> {
    this.requireStorage();
    const row = await this.repo.findOne({
      where: { uploadId, platformId: platform.id },
    });
    if (!row)
      throw new NotFoundException({
        success: false,
        code: 'EVIDENCE_NOT_FOUND',
      });
    if (row.state === 'accepted') {
      return {
        evidence_id: row.id,
        upload_id: row.uploadId,
        state: row.state,
        sha256: row.sha256,
      };
    }
    if (row.state !== 'quarantined') {
      throw new BadRequestException({
        success: false,
        code: 'EVIDENCE_NOT_PENDING',
        message: `evidence is ${row.state}`,
      });
    }
    const settings = effectiveSettings(platform);
    const reject = async (code: string) => {
      row.state = 'rejected';
      row.rejectionCode = code;
      await this.repo.save(row);
      await this.storage.delete(row.storageKey).catch(() => undefined);
      throw new BadRequestException({
        success: false,
        code,
        message: 'Evidence rejected',
      });
    };
    const head = await this.storage.head(row.storageKey);
    if (!head) await reject('EVIDENCE_OBJECT_MISSING');
    const declared = Number(row.sizeBytes);
    if (
      !head ||
      head.size !== declared ||
      head.size > settings.max_evidence_bytes
    ) {
      await reject('EVIDENCE_SIZE_MISMATCH');
    }
    if (head!.contentType && head!.contentType.toLowerCase() !== row.mimeType) {
      await reject('EVIDENCE_TYPE_MISMATCH');
    }
    let sha: string;
    try {
      sha = await this.storage.sha256(
        row.storageKey,
        settings.max_evidence_bytes,
      );
    } catch {
      await reject('EVIDENCE_UNREADABLE');
      return undefined as never;
    }
    if (
      typeof declaredSha256 === 'string' &&
      declaredSha256.trim() &&
      declaredSha256.trim().toLowerCase() !== sha
    ) {
      await reject('EVIDENCE_HASH_MISMATCH');
    }
    const ext = EXT_BY_MIME[row.mimeType] ?? '';
    const acceptedKey = this.storage.acceptedKey(
      row.connectionId,
      row.uploadId,
      ext,
    );
    await this.storage.move(row.storageKey, acceptedKey);
    row.storageKey = acceptedKey;
    row.sha256 = sha;
    row.state = 'accepted';
    row.acceptedAt = new Date();
    await this.repo.save(row);
    return {
      evidence_id: row.id,
      upload_id: row.uploadId,
      state: row.state,
      sha256: sha,
    };
  }

  async list(filters: {
    page?: unknown;
    limit?: unknown;
    connectionId?: string;
    recordId?: string;
    state?: string;
    organizationId?: string;
  }) {
    const { page, limit, skip } = parsePage(filters.page, filters.limit);
    const qb = this.repo
      .createQueryBuilder('e')
      .orderBy('e.createdAt', 'DESC')
      .skip(skip)
      .take(limit);
    if (filters.organizationId) {
      // Organization scope: only evidence of that organization's connections.
      qb.innerJoin(
        ExternalConnection,
        'c',
        'c.id = e.connectionId AND c.organizationId = :oid',
        { oid: filters.organizationId },
      );
    }
    const connectionId = uuidFilter(filters.connectionId, 'connectionId');
    const recordId = uuidFilter(filters.recordId, 'recordId');
    if (connectionId)
      qb.andWhere('e.connectionId = :cid', { cid: connectionId });
    if (recordId) qb.andWhere('e.recordId = :rid', { rid: recordId });
    if (filters.state)
      qb.andWhere('e.state = :state', { state: filters.state });
    const [rows, total] = await qb.getManyAndCount();
    return { rows, total, page, limit };
  }

  /** Signed view URL for an authorized human viewer; audited. */
  async viewUrl(
    id: string,
    viewer: {
      actor: HubActor;
      organizationId?: string;
      allowRestricted: boolean;
    },
  ): Promise<{ url: string; expires_in_seconds: number; mime_type: string }> {
    this.requireStorage();
    const row = await this.repo.findOne({ where: { id } });
    if (!row || row.state !== 'accepted')
      throw new NotFoundException('Evidence not found');
    if (!viewer.allowRestricted) {
      if (!viewer.organizationId)
        throw new NotFoundException('Evidence not found');
      const conn = await this.connections.getForOrganization(
        row.connectionId,
        viewer.organizationId,
      );
      if (!conn.orgEvidenceOpenAllowed) {
        throw new NotFoundException('Evidence not found');
      }
    }
    const url = await this.storage.presignView(row.storageKey, 300);
    await this.audit.log({
      actor: viewer.actor,
      action: 'EVIDENCE_OPENED',
      targetType: 'evidence',
      targetId: row.id,
      connectionId: row.connectionId,
      details: { mimeType: row.mimeType, sizeBytes: row.sizeBytes },
    });
    return { url, expires_in_seconds: 300, mime_type: row.mimeType };
  }

  /** Deletes the object and marks the row purged; the metadata row stays for audit. */
  async purge(row: ExternalEvidence, reason: string): Promise<void> {
    if (this.storage.configured) {
      await this.storage.delete(row.storageKey).catch(() => undefined);
    }
    row.state = 'purged';
    row.purgedAt = new Date();
    row.rejectionCode = row.rejectionCode ?? reason;
    await this.repo.save(row);
  }
}

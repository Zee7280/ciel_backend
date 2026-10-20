import { Injectable } from '@nestjs/common';
import {
  DataSource,
  EntitySubscriberInterface,
  InsertEvent,
  UpdateEvent,
} from 'typeorm';
import {
  Opportunity,
  verificationTokenTtlMs,
} from './entities/opportunity.entity';

type TokenPair = Pick<
  Opportunity,
  | 'partnerToken'
  | 'partnerTokenExpiresAt'
  | 'faculty_verification_token'
  | 'facultyTokenExpiresAt'
>;

/** Any newly issued or rotated public verification token gets a fresh expiry; a revoked token
 * drops it. Rows whose token is unchanged keep their expiry (legacy null = no retroactive expiry). */
export function stampVerificationTokenExpiry(
  next: TokenPair,
  previous?: Partial<TokenPair> | null,
  now = Date.now(),
): void {
  const expiresAt = () => new Date(now + verificationTokenTtlMs());
  // Only act on a token the write actually carries. A partial `update(id, {…})` hands this hook just
  // the columns being set: reading a missing token as "revoked" nulled the expiry of every pending
  // reviewer link on unrelated updates, turning expiring links into permanent ones.
  if (next.partnerToken !== undefined) {
    if (!next.partnerToken) {
      next.partnerTokenExpiresAt = null;
    } else if (next.partnerToken !== (previous?.partnerToken ?? null)) {
      next.partnerTokenExpiresAt = expiresAt();
    }
  }
  if (next.faculty_verification_token !== undefined) {
    if (!next.faculty_verification_token) {
      next.facultyTokenExpiresAt = null;
    } else if (
      next.faculty_verification_token !==
      (previous?.faculty_verification_token ?? null)
    ) {
      next.facultyTokenExpiresAt = expiresAt();
    }
  }
}

@Injectable()
export class OpportunityTokenExpirySubscriber implements EntitySubscriberInterface<Opportunity> {
  constructor(dataSource: DataSource) {
    dataSource.subscribers.push(this);
  }

  listenTo() {
    return Opportunity;
  }

  beforeInsert(event: InsertEvent<Opportunity>) {
    if (event.entity) stampVerificationTokenExpiry(event.entity);
  }

  beforeUpdate(event: UpdateEvent<Opportunity>) {
    // Partial column updates (`repo.update`) have no entity — only full saves carry tokens here.
    if (event.entity) {
      stampVerificationTokenExpiry(
        event.entity as Opportunity,
        event.databaseEntity,
      );
    }
  }
}

/**
 * One-time backfill — run this BEFORE (or immediately when) deploying the new NGO login
 * verification gate (auth.service.ts login()). Without it, any NGO organization that is already
 * live (its user account status is 'active') but whose Organization.verificationStatus is still
 * the default 'PENDING' — because that field was never enforced anywhere before this fix — would
 * suddenly be locked out at next login, even though nothing about the account actually changed.
 *
 * This sets verificationStatus = 'APPROVED' only for organizations backing an already-active NGO
 * user, so existing partners keep working. Any NGO signup from this point forward starts at
 * 'PENDING' and genuinely needs a CIEL PK admin to approve/reject it via the existing
 * admin-organizations approve/reject endpoints, matching what the signup screen has always
 * promised.
 *
 * Usage: npx ts-node grandfather-ngo-verification.ts
 */

import { DataSource } from 'typeorm';
import { User } from './src/users/entities/user.entity';
import { Organization } from './src/organizations/entities/organization.entity';
import { UserRole } from './src/users/enums/user-role.enum';

const AppDataSource = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    username: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || 'zain',
    database: process.env.DB_NAME || 'ciel',
    entities: [User, Organization],
    synchronize: false,
    // Same trigger as app.module.ts's TypeORM config — the production (Vercel) Postgres requires
    // SSL, and this script is meant to be pointed at that same database from a local machine.
    ssl:
        process.env.NODE_ENV === 'production' || process.env.DB_SSL === 'true'
            ? { rejectUnauthorized: false }
            : undefined,
});

async function run() {
    try {
        await AppDataSource.initialize();
        console.log('Database connected');

        const userRepository = AppDataSource.getRepository(User);
        const orgRepository = AppDataSource.getRepository(Organization);

        const activeNgoUsers = await userRepository.find({
            where: { role: UserRole.NGO, status: 'active' },
            relations: ['organization'],
        });

        const orgIdsToApprove = new Set<string>();
        for (const user of activeNgoUsers) {
            if (user.organization && user.organization.verificationStatus !== 'APPROVED') {
                orgIdsToApprove.add(user.organization.id);
            }
        }

        console.log(`Found ${activeNgoUsers.length} active NGO user(s), ${orgIdsToApprove.size} organization(s) need grandfathering.`);

        if (orgIdsToApprove.size === 0) {
            console.log('Nothing to do.');
            return;
        }

        for (const orgId of orgIdsToApprove) {
            const org = await orgRepository.findOne({ where: { id: orgId } });
            if (!org) continue;
            org.verificationStatus = 'APPROVED';
            org.verificationNotes = [org.verificationNotes, 'Grandfathered: was already an active account before the login verification gate was added.']
                .filter(Boolean)
                .join('\n');
            await orgRepository.save(org);
            console.log(`Approved (grandfathered): ${org.id} — ${org.name}`);
        }

        console.log('Done.');
    } catch (error) {
        console.error('Error:', error);
    } finally {
        if (AppDataSource.isInitialized) {
            await AppDataSource.destroy();
        }
    }
}

run();

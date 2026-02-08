
import { DataSource } from 'typeorm';
import { User } from './src/users/entities/user.entity';
import { Organization } from './src/organizations/entities/organization.entity';
// Import other entities to avoid relation errors if they are eager loaded or referenced
import { Opportunity } from './src/opportunities/entities/opportunity.entity';
import { Timesheet } from './src/timesheets/entities/timesheet.entity';
import { Report } from './src/reports/entities/report.entity';
// We might need to mock or ignore some if not needed, but loading all is safer

const AppDataSource = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    username: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || 'zain',
    database: process.env.DB_NAME || 'ciel',
    entities: [User, Organization, Opportunity, Timesheet, Report],
    synchronize: false,
});

async function run() {
    try {
        await AppDataSource.initialize();
        console.log('Database connected');

        const userId = '61ed5ee2-ca81-4644-810a-656053f1da97';
        const userRepository = AppDataSource.getRepository(User);
        const orgRepository = AppDataSource.getRepository(Organization);

        const user = await userRepository.findOne({
            where: { id: userId },
            relations: ['organization']
        });

        if (!user) {
            console.log('User not found');
            return;
        }

        console.log('User details:', {
            id: user.id,
            email: user.email,
            role: user.role,
            orgName: user.orgName,
            orgType: user.orgType,
            organization: user.organization ? { id: user.organization.id, name: user.organization.name } : null
        });

        if (!user.organization) {
            console.log('User has no organization linked. Creating one...');

            // Checking if org with same name exists?
            const existingOrg = await orgRepository.findOne({ where: { contactEmail: user.email } });

            if (existingOrg) {
                console.log('Found existing org by email, linking...');
                user.organization = existingOrg;
                await userRepository.save(user);
                console.log('Linked to:', existingOrg.id);
            } else {
                console.log('Creating new org...');
                const newOrg = orgRepository.create({
                    name: user.orgName || user.name || 'Default Organization',
                    orgType: user.orgType || 'CORPORATE',
                    contactEmail: user.email,
                    verificationStatus: 'APPROVED'
                });

                const savedOrg = await orgRepository.save(newOrg);
                console.log('Organization created:', savedOrg.id);

                user.organization = savedOrg;
                await userRepository.save(user);
                console.log('User linked to new organization');
            }
        } else {
            console.log('User already has an organization linked.');
        }

    } catch (error) {
        console.error('Error:', error);
    } finally {
        if (AppDataSource.isInitialized) {
            await AppDataSource.destroy();
        }
    }
}

run();

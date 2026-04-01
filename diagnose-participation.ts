import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { Participation } from './src/engagement/entities/participant.entity';
import { User } from './src/users/entities/user.entity';
import { DataSource } from 'typeorm';

async function bootstrap() {
    const app = await NestFactory.createApplicationContext(AppModule);
    const dataSource = app.get(DataSource);
    const participantRepo = dataSource.getRepository(Participation);
    const userRepo = dataSource.getRepository(User);

    const aliId = '7e03a766-438f-402a-9fa5-e4578172f8e2';
    const zainId = 'a4685912-23ba-43c6-94a3-2283aeca378b';
    const participationId = '52b82c50-9c2c-4552-8902-f422cde7a257';

    console.log('Checking records...');

    const ali = await userRepo.findOne({ where: { id: aliId } });
    console.log('Ali User:', ali ? { id: ali.id, email: ali.email } : 'Not found');

    const zain = await userRepo.findOne({ where: { id: zainId } });
    console.log('Zain User:', zain ? { id: zain.id, email: zain.email } : 'Not found');

    const participation = await participantRepo.findOne({ where: { id: participationId } });
    console.log('Participation Record:', participation ? { 
        id: participation.id, 
        studentId: participation.studentId, 
        email: participation.email,
        fullName: participation.fullName
    } : 'Not found');

    await app.close();
}

bootstrap().catch(err => {
    console.error(err);
    process.exit(1);
});

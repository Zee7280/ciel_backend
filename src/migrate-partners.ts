import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { UsersService } from './users/users.service';
import { UserRole } from './users/enums/user-role.enum';
import { DataSource } from 'typeorm';

async function bootstrap() {
    const app = await NestFactory.createApplicationContext(AppModule);
    const dataSource = app.get(DataSource);

    console.log('Starting migration: Partner -> NGO');

    // Direct SQL update for efficiency and to bypass potential code checks
    const result = await dataSource.query(
        `UPDATE users SET role = 'ngo' WHERE role = 'partner'`
    );

    console.log('Migration complete. Result:', result); // Check what result format is (often [affectedRows])

    await app.close();
}

bootstrap();

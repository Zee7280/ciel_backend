
import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { UsersService } from './src/users/users.service';

async function bootstrap() {
    const app = await NestFactory.createApplicationContext(AppModule);
    const usersService = app.get(UsersService);

    console.log('Listing users...');
    const users = await usersService.findAll();
    if (users.length > 0) {
        console.log('First 5 users:');
        users.slice(0, 5).forEach(u => console.log(`ID: ${u.id}, Email: ${u.email}, Role: ${u.role}`));
    } else {
        console.log('No users found in DB.');
    }

    await app.close();
}

bootstrap();

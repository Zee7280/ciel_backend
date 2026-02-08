
import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { UsersService } from './src/users/users.service';

async function bootstrap() {
    const app = await NestFactory.createApplicationContext(AppModule);
    const usersService = app.get(UsersService);

    const email = 'ngo2@ciel.pk';
    console.log(`Checking for user with email: ${email}`);

    const user = await usersService.findByEmail(email);
    if (user) {
        console.log('User found:', user);
    } else {
        console.log('User NOT found');
    }

    await app.close();
}

bootstrap();

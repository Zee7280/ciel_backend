
import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { UsersService } from './src/users/users.service';

async function bootstrap() {
    const app = await NestFactory.createApplicationContext(AppModule);
    const usersService = app.get(UsersService);

    const payload = {
        name: "",
        email: "ngo2@ciel.pk",
        password: "demo", // Plain text, assuming service hashes it or we mock hashing
        institution: "",
        department: "",
        orgName: "qqqqqq",
        orgType: "ngo",
        contactPerson: "qqqqqq",
        role: "partner"
    };

    console.log('Attempting to create user with payload:', payload);

    try {
        const user = await usersService.create(payload as any);
        console.log('User created successfully:', user.id);
    } catch (error) {
        console.error('Error creating user:', error);
        if (error.code) {
            console.error('Error code:', error.code);
            console.error('Error detail:', error.detail);
        }
    }

    await app.close();
}

bootstrap();

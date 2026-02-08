import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { ProfileController } from './profile.controller';

@Module({
    imports: [TypeOrmModule.forFeature([User])],
    controllers: [UsersController, ProfileController],
    providers: [UsersService],
    exports: [UsersService],
})
export class UsersModule { }

import { Controller, Get, Request, UseGuards, Post, Body, UseInterceptors, UploadedFiles } from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { S3Service } from '../common/s3.service';
import { UserRole } from './enums/user-role.enum';

@Controller('user')
export class UsersController {
    constructor(
        private readonly usersService: UsersService,
        private readonly s3Service: S3Service
    ) { }

    @UseGuards(JwtAuthGuard)
    @Get('me')
    getProfile(@Request() req) {
        // req.user has the payload from JwtStrategy (userId, email, role)
        // We user userId to fetch full profile
        return this.usersService.getProfile(req.user.id);
    }

    @UseGuards(JwtAuthGuard)
    @Post('me')
    getProfilePost(@Request() req) {
        return this.usersService.getProfile(req.user.id);
    }

    @Post('update')
    @UseGuards(JwtAuthGuard) // Ensure user is authenticated to update THEIR profile
    @UseInterceptors(FileFieldsInterceptor([
        { name: 'image', maxCount: 1 },
        { name: 'avatar', maxCount: 1 },
    ]))
    async updateProfile(@Request() req, @Body() body: any, @UploadedFiles() files: any) {
        // `userId` in the body is only honoured as an admin override. Any other caller edits
        // their own profile only — otherwise any authenticated user could rewrite (and self-verify)
        // anybody else's account.
        const isAdminCaller = req.user?.role === UserRole.SUPER_ADMIN;
        const requestedUserId = body?.userId ? String(body.userId) : null;
        // Non-admins always edit themselves — a stale/spoofed body id is ignored, not honoured.
        const targetUserId = isAdminCaller && requestedUserId ? requestedUserId : req.user.id;

        // Map 'contact' to 'phone', 'image' to 'avatar'
        const dto: any = { ...body };
        if (body.contact) dto.phone = body.contact;
        if (body.university) dto.university = body.university;
        if (body.department) dto.department = body.department;
        if (body.faculty_department) dto.faculty_department = body.faculty_department;
        const file = files?.image?.[0] || files?.avatar?.[0];
        if (file) {
            dto.avatar = await this.s3Service.uploadFile(file, 'users');
        }

        // Remove 'image' and 'contact' from dto to clean up if strictly typed, but UsersService update is generic usually.
        // UsersService.updateProfile in d:\saevolgo\ciel-api\src\users\users.service.ts likely needs to support this.
        // We will delegate logic to service.

        return this.usersService.updateGenericProfile(targetUserId, dto, { isAdminCaller });
    }
}

/** Backward-compatible plural route used by frontend helpers (`/api/v1/users/me`). */
@Controller('users')
export class UsersAliasController {
    constructor(private readonly usersService: UsersService) { }

    @UseGuards(JwtAuthGuard)
    @Get('me')
    getProfile(@Request() req) {
        return this.usersService.getProfile(req.user.id);
    }
}

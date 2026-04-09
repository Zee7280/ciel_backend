import { Controller, Get, Request, UseGuards, Post, Body, UseInterceptors, UploadedFile, BadRequestException } from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FileInterceptor } from '@nestjs/platform-express';
import { S3Service } from '../common/s3.service';

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

    @Post('me')
    getProfilePost(@Body() body: { userId: string }) {
        console.log('getProfilePost body:', JSON.stringify(body));
        return this.usersService.getProfile(body.userId);
    }

    @Post('update')
    @UseGuards(JwtAuthGuard) // Ensure user is authenticated to update THEIR profile
    @UseInterceptors(FileInterceptor('image'))
    async updateProfile(@Request() req, @Body() body: any, @UploadedFile() file: any) {
        // For 'multipart/form-data', body fields might need parsing if complex, but simple strings are fine.
        // User passed 'userId' in body, but we should prefer req.user.id for security, OR allow admin override.
        // The prompt says "userId: 123" in body.
        const targetUserId = body.userId || req.user.id;

        // Map 'contact' to 'phone', 'image' to 'avatar'
        const dto: any = { ...body };
        if (body.contact) dto.phone = body.contact;
        if (body.university) dto.university = body.university;
        if (body.department) dto.department = body.department;
        if (body.faculty_department) dto.faculty_department = body.faculty_department;
        if (file) {
            dto.avatar = await this.s3Service.uploadFile(file, 'users');
        }

        // Remove 'image' and 'contact' from dto to clean up if strictly typed, but UsersService update is generic usually.
        // UsersService.updateProfile in d:\saevolgo\ciel-api\src\users\users.service.ts likely needs to support this.
        // We will delegate logic to service.

        return this.usersService.updateGenericProfile(targetUserId, dto);
    }
}

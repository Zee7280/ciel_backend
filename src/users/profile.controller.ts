
import { Controller, Get, Put, Post, Body, UseGuards, Request, BadRequestException } from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('profile')
@UseGuards(JwtAuthGuard)
export class ProfileController {
    constructor(private readonly usersService: UsersService) { }

    @Get()
    getProfile(@Request() req) {
        return this.usersService.getProfile(req.user.id);
    }

    @Put()
    async updateProfile(@Request() req, @Body() body: any) {
        const result = await this.usersService.updateGenericProfile(req.user.id, body);
        return { success: true, data: result.data };
    }

    @Post('change-password')
    async changePassword(@Request() req, @Body() body: any) {
        try {
            return await this.usersService.changePassword(req.user.id, body);
        } catch (error) {
            throw new BadRequestException(error.message);
        }
    }
}

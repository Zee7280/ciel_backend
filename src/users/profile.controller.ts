
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
        // Only allow updating certain fields
        const { name, phone, avatar } = body;
        const updateData: any = {};
        if (name) updateData.name = name;
        if (phone) updateData.phone = phone;
        if (avatar) updateData.avatar = avatar;

        const updatedUser = await this.usersService.update(req.user.id, updateData);
        return { success: true, data: await this.usersService.formatUserResponse(updatedUser) };
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

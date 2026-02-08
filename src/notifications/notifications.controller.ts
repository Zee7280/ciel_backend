
import { Controller, Get, Put, Delete, Param, Query, UseGuards, Request, ParseIntPipe } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
    constructor(private readonly notificationsService: NotificationsService) { }

    @Get()
    async findAll(@Request() req, @Query() query) {
        const data = await this.notificationsService.findAll(req.user.id, query);
        return { success: true, data };
    }

    @Put(':id/read')
    markAsRead(@Request() req, @Param('id', ParseIntPipe) id: number) {
        return this.notificationsService.markAsRead(id, req.user.id);
    }

    @Delete(':id')
    remove(@Request() req, @Param('id', ParseIntPipe) id: number) {
        return this.notificationsService.remove(id, req.user.id);
    }
}

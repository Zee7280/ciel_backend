import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  Request,
  Patch,
  Param,
  Query,
} from '@nestjs/common';
import { ChatService } from './chat.service';
import { CreateConversationDto, CreateMessageDto } from './dto/chat.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

type AuthenticatedRequest = {
  user: { id: string };
  body?: Record<string, unknown>;
};

@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @UseGuards(JwtAuthGuard)
  @Post('conversations')
  async createConversation(
    @Request() req: AuthenticatedRequest,
    @Body() createConversationDto: CreateConversationDto,
  ) {
    // Fallback for cases where req.body doesn't perfectly match the DTO class structure
    let rawParticipantIds: unknown =
      createConversationDto?.participantIds || req.body?.participantIds;

    // Handle cases where body was parsed weirdly (e.g. single string instead of array, or "participantIds[0]" form-data)
    if (typeof rawParticipantIds === 'string') {
      try {
        rawParticipantIds = JSON.parse(rawParticipantIds);
      } catch {
        rawParticipantIds = [rawParticipantIds];
      }
    }

    // Ensure it's an iterable array, else default to empty
    const participantIds: string[] = Array.isArray(rawParticipantIds)
      ? (rawParticipantIds as string[])
      : [];

    const payload: CreateConversationDto = {
      participantIds,
      type:
        createConversationDto?.type ||
        (req.body?.type as string | undefined) ||
        'DIRECT',
    };

    const data = await this.chatService.createConversation(
      payload,
      req.user.id,
    );
    return { success: true, data };
  }

  @UseGuards(JwtAuthGuard)
  @Get('conversations')
  async getConversations(@Request() req: AuthenticatedRequest) {
    const data = await this.chatService.getConversations(req.user.id);
    return { success: true, data };
  }

  @UseGuards(JwtAuthGuard)
  @Get('conversations/:id/messages')
  async getMessages(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    const data = await this.chatService.getMessages(id, req.user.id);
    return { success: true, data };
  }

  @UseGuards(JwtAuthGuard)
  @Post('messages')
  async sendMessage(
    @Request() req: AuthenticatedRequest,
    @Body() createMessageDto: CreateMessageDto,
  ) {
    // Fallback for cases where req.body doesn't perfectly match the DTO class structure
    // e.g., missing text/json headers from frontend.
    const payload: CreateMessageDto = {
      conversationId:
        createMessageDto?.conversationId ||
        (req.body?.conversationId as string),
      content: createMessageDto?.content || (req.body?.content as string),
    };

    const data = await this.chatService.sendMessage(payload, req.user.id);
    return { success: true, data };
  }

  @UseGuards(JwtAuthGuard)
  @Patch('conversations/:id/read')
  async markAsRead(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    const data = await this.chatService.markAsRead(id, req.user.id);
    return { ...data };
  }

  @UseGuards(JwtAuthGuard)
  @Get('unread-count')
  async getUnreadCount(@Request() req: AuthenticatedRequest) {
    const count = await this.chatService.getUnreadCount(req.user.id);
    return { success: true, data: { count } };
  }

  @UseGuards(JwtAuthGuard)
  @Get('users')
  async getChatUsers(
    @Request() req: AuthenticatedRequest,
    @Query('search') search: string,
  ) {
    const users = await this.chatService.getChatUsers(req.user.id, search);
    return { success: true, data: users };
  }
}

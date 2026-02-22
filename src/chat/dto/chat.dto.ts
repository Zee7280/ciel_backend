export class CreateMessageDto {
    conversationId: string;
    content: string;
}

export class CreateConversationDto {
    participantIds: string[];
    type?: string;
}

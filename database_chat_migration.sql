-- Database Migration for Chat System

-- Table: conversations
CREATE TABLE IF NOT EXISTS "conversations" (
    "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
    "type" character varying NOT NULL DEFAULT 'DIRECT',
    "lastMessageId" uuid,
    "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
    CONSTRAINT "PK_conversations_id" PRIMARY KEY ("id")
);

-- Table: conversation_participants
CREATE TABLE IF NOT EXISTS "conversation_participants" (
    "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
    "conversationId" uuid NOT NULL,
    "userId" uuid NOT NULL,
    "joinedAt" TIMESTAMP NOT NULL DEFAULT now(),
    CONSTRAINT "PK_conversation_participants_id" PRIMARY KEY ("id"),
    CONSTRAINT "FK_conversation_participants_conversationId" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE,
    CONSTRAINT "FK_conversation_participants_userId" FOREIGN KEY ("userId") REFERENCES "users"("id")
);

-- Table: messages
CREATE TABLE IF NOT EXISTS "messages" (
    "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
    "conversationId" uuid NOT NULL,
    "senderId" uuid NOT NULL,
    "content" text NOT NULL,
    "isRead" boolean NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
    CONSTRAINT "PK_messages_id" PRIMARY KEY ("id"),
    CONSTRAINT "FK_messages_conversationId" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE,
    CONSTRAINT "FK_messages_senderId" FOREIGN KEY ("senderId") REFERENCES "users"("id")
);

-- Add foreign key constraint to conversations after messages table is created
ALTER TABLE "conversations" 
ADD CONSTRAINT "FK_conversations_lastMessageId" 
FOREIGN KEY ("lastMessageId") REFERENCES "messages"("id");

-- Indexes for performance
CREATE INDEX IF NOT EXISTS "IDX_messages_conversationId" ON "messages" ("conversationId");
CREATE INDEX IF NOT EXISTS "IDX_messages_senderId" ON "messages" ("senderId");
CREATE INDEX IF NOT EXISTS "IDX_conversation_participants_conversationId" ON "conversation_participants" ("conversationId");
CREATE INDEX IF NOT EXISTS "IDX_conversation_participants_userId" ON "conversation_participants" ("userId");

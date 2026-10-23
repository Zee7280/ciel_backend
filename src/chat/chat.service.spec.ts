import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ChatService } from './chat.service';

describe('ChatService — directory and conversation limits', () => {
  const build = (users: Array<Record<string, unknown>> = []) => {
    const qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(users),
    };
    const usersRepo = {
      createQueryBuilder: jest.fn(() => qb),
      count: jest.fn().mockResolvedValue(0),
    };
    const svc = new ChatService(
      {} as never,
      {} as never,
      {} as never,
      usersRepo as never,
    );
    return { svc, qb, usersRepo };
  };
  const alice = {
    id: 'a',
    name: 'Alice',
    email: 'alice@uni.edu.pk',
    role: 'student',
    avatar: null,
  };

  it('masks emails for non-admins and matches email only in full', async () => {
    const { svc, qb } = build([alice]);
    const rows = await svc.getChatUsers('me', '@uni.edu.pk', 'student');
    expect(rows[0].email).toBe('al***@uni.edu.pk');
    expect(qb.andWhere).toHaveBeenLastCalledWith(
      '(user.name ILIKE :search OR LOWER(user.email) = :exactEmail)',
      { search: '%@uni.edu.pk%', exactEmail: '@uni.edu.pk' },
    );
  });

  it('shows the admin full emails and partial email search', async () => {
    const { svc, qb } = build([alice]);
    const rows = await svc.getChatUsers('me', 'uni.edu', 'admin');
    expect(rows[0].email).toBe('alice@uni.edu.pk');
    expect(qb.andWhere).toHaveBeenLastCalledWith(
      '(user.name ILIKE :search OR user.email ILIKE :search)',
      { search: '%uni.edu%' },
    );
  });

  it('only lets the admin open group chats, and refuses unknown types', async () => {
    const { svc, usersRepo } = build();
    await expect(
      svc.createConversation(
        { participantIds: ['b', 'c'], type: 'GROUP' },
        'me',
        'student',
      ),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      svc.createConversation(
        { participantIds: ['b', 'c'], type: 'BROADCAST' },
        'me',
        'admin',
      ),
    ).rejects.toThrow(BadRequestException);
    expect(usersRepo.count).not.toHaveBeenCalled();
  });
});

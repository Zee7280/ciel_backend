import { SettingsController } from './settings.controller';

describe('SettingsController.updateSettings', () => {
  const build = (settings: Record<string, unknown>) => {
    const users = {
      findOne: jest.fn().mockResolvedValue({ id: 'u1', settings }),
      update: jest.fn().mockResolvedValue(undefined),
    };
    return { controller: new SettingsController(users as never), users };
  };

  it('saves the preference keys and keeps server-written settings untouched', async () => {
    const investor = { kycStatus: 'pending', proofDocuments: ['a'] };
    const { controller, users } = build({ investor });
    await controller.updateSettings(
      { user: { id: 'u1' } },
      {
        notifications: { email: false },
        privacy: { showEmail: true },
        language: 'ur',
        theme: 'dark',
        investor: { kycStatus: 'verified' },
        role: 'admin',
      },
    );
    expect(users.update).toHaveBeenCalledWith('u1', {
      settings: {
        investor,
        notifications: { email: false },
        privacy: { showEmail: true },
        language: 'ur',
        theme: 'dark',
      },
    });
  });
});

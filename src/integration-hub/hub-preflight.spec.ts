import { preflightHub } from './hub-preflight';

describe('preflightHub', () => {
  it('does nothing when the hub is not configured', async () => {
    const env: NodeJS.ProcessEnv = {};
    await expect(preflightHub(env, 500)).resolves.toBe(false);
    expect(env.HUB_DATABASE_URL).toBeUndefined();
  });

  it('clears the hub URL (hub off, core on) when the hub database is unreachable', async () => {
    const env: NodeJS.ProcessEnv = {
      HUB_DATABASE_URL: 'postgres://ciel_hub_app:wrong@127.0.0.1:1/nope',
    };
    await expect(preflightHub(env, 1500)).resolves.toBe(false);
    expect(env.HUB_DATABASE_URL).toBe('');
  });
});

import { HttpException } from '@nestjs/common';
import { VerificationsController } from './verifications.controller';

describe('VerificationsController — legacy GET verify never mutates and never fakes success', () => {
    const controller = new VerificationsController({} as never, {} as never);
    const res = () => ({ redirect: jest.fn() });

    it('redirects a browser navigation (Accept: text/html) to the frontend confirm page', () => {
        process.env.FRONTEND_URL = 'https://app.example.com/';
        const r = res();
        controller.verifyOpportunityLegacyGet(' tok-1 ', 'text/html,application/xhtml+xml', r as never);
        expect(r.redirect).toHaveBeenCalledWith(302, 'https://app.example.com/verify-project?token=tok-1');
    });

    it.each([undefined, '*/*', 'application/json'])(
        'returns 405 JSON (no redirect) to a non-browser caller with Accept=%s',
        (accept) => {
            const r = res();
            try {
                controller.verifyOpportunityLegacyGet('tok-1', accept, r as never);
                throw new Error('expected 405');
            } catch (e) {
                expect(e).toBeInstanceOf(HttpException);
                expect((e as HttpException).getStatus()).toBe(405);
                expect(((e as HttpException).getResponse() as any).success).toBe(false);
            }
            expect(r.redirect).not.toHaveBeenCalled();
        },
    );

    it('rejects an empty token with 400', () => {
        expect(() => controller.verifyOpportunityLegacyGet('  ', 'text/html', res() as never)).toThrow(HttpException);
    });
});

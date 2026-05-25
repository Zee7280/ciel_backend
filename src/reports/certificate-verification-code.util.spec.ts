import { formatCertificateVerificationCode } from './certificate-verification-code.util';

describe('formatCertificateVerificationCode', () => {
    it('formats verification_public_slug into CIL display groups', () => {
        expect(formatCertificateVerificationCode('fa0d-ca28-abdf-4c15-b008')).toMatch(
            /^CIL-\d{2}-FA0D-CA28-ABDF-4C15-B008$/,
        );
    });

    it('returns null when slug is missing', () => {
        expect(formatCertificateVerificationCode(null)).toBeNull();
        expect(formatCertificateVerificationCode('')).toBeNull();
    });
});

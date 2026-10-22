import { sanitizeSignupProofDocuments } from './signup-proof.util';

const BUCKET = 'https://bucket.s3.eu-north-1.amazonaws.com/';
const keyFromPublicUrl = (url: string) =>
  url.startsWith(BUCKET) ? decodeURIComponent(url.slice(BUCKET.length)) : null;
const NOW = new Date('2026-10-22T10:00:00Z');

describe('sanitizeSignupProofDocuments', () => {
  it('keeps our own signup-proof uploads and stamps them', () => {
    const out = sanitizeSignupProofDocuments(
      [
        {
          label: 'Proof of role',
          url: `${BUCKET}signup-proofs/a.pdf`,
          fileName: 'card.pdf',
        },
      ],
      keyFromPublicUrl,
      NOW,
    );
    expect(out).toEqual([
      {
        label: 'Proof of role',
        url: `${BUCKET}signup-proofs/a.pdf`,
        fileName: 'card.pdf',
        uploadedAt: NOW.toISOString(),
      },
    ]);
  });

  it('drops outside links and files from other folders', () => {
    const out = sanitizeSignupProofDocuments(
      [
        { label: 'x', url: 'https://evil.example.com/signup-proofs/a.pdf' },
        { label: 'y', url: `${BUCKET}membership-proofs/b.png` },
        { label: 'z', url: '' },
      ],
      keyFromPublicUrl,
    );
    expect(out).toEqual([]);
  });

  it('caps the list at four and tolerates missing input', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      label: `d${i}`,
      url: `${BUCKET}signup-proofs/${i}.png`,
    }));
    expect(sanitizeSignupProofDocuments(many, keyFromPublicUrl)).toHaveLength(
      4,
    );
    expect(sanitizeSignupProofDocuments(undefined, keyFromPublicUrl)).toEqual(
      [],
    );
  });
});

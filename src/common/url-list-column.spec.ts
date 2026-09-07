import { normalizeUrlList, parseStoredUrlList, serializeUrlList } from './url-list-column';

describe('url-list-column', () => {
    it('serializes multiple S3 URLs as JSON so commas cannot split them', () => {
        const urls = [
            'https://bucket.s3.eu-north-1.amazonaws.com/paths-evidence/a.pdf',
            'https://bucket.s3.eu-north-1.amazonaws.com/paths-evidence/b.png',
        ];
        expect(serializeUrlList(urls)).toBe(JSON.stringify(urls));
        expect(parseStoredUrlList(serializeUrlList(urls))).toEqual(urls);
    });

    it('reads the legacy TypeORM simple-array CSV of public URLs', () => {
        const csv =
            'https://bucket.s3.eu-north-1.amazonaws.com/paths-evidence/a.pdf,https://bucket.s3.eu-north-1.amazonaws.com/paths-evidence/b.png';
        expect(parseStoredUrlList(csv)).toEqual([
            'https://bucket.s3.eu-north-1.amazonaws.com/paths-evidence/a.pdf',
            'https://bucket.s3.eu-north-1.amazonaws.com/paths-evidence/b.png',
        ]);
    });

    it('does not hydrate an empty column as a ghost empty-string file', () => {
        expect(parseStoredUrlList('')).toEqual([]);
        expect(parseStoredUrlList(null)).toEqual([]);
        expect(normalizeUrlList(['', 'https://files.example.com/a.pdf', '  '])).toEqual([
            'https://files.example.com/a.pdf',
        ]);
        expect(serializeUrlList([])).toBeNull();
    });

    it('reads a JSON string the way TypeORM leaves it on the entity after save', () => {
        expect(parseStoredUrlList('["https://files.example.com/a.pdf","https://files.example.com/b.png"]')).toEqual([
            'https://files.example.com/a.pdf',
            'https://files.example.com/b.png',
        ]);
    });

    it('keeps a single public URL intact (no comma split)', () => {
        const url = 'https://bucket.s3.eu-north-1.amazonaws.com/paths-evidence/only.pdf';
        expect(parseStoredUrlList(url)).toEqual([url]);
    });
});

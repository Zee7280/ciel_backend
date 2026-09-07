/**
 * TypeORM `simple-array` joins with commas. Coursework evidence is a list of S3 URLs —
 * splitting on every comma both drops files (empty string hydrates as `['']`) and would
 * corrupt any URL that ever contained a comma. Store JSON in the existing text column
 * and still read the legacy CSV shape.
 */
export function normalizeUrlList(raw: unknown): string[] {
    const parts = Array.isArray(raw) ? raw : splitStoredUrlString(raw);
    return [...new Set(parts.map((u) => String(u ?? '').trim()).filter(Boolean))];
}

function splitStoredUrlString(raw: unknown): string[] {
    if (raw == null) return [];
    const s = String(raw).trim();
    if (!s) return [];
    if (s.startsWith('[')) {
        try {
            const parsed = JSON.parse(s) as unknown;
            if (Array.isArray(parsed)) return parsed.map((u) => String(u ?? ''));
        } catch {
            /* fall through to CSV */
        }
    }
    return s.split(/,(?=https?:\/\/)/i);
}

export function serializeUrlList(value: string[] | null | undefined): string | null {
    const urls = normalizeUrlList(value);
    return urls.length ? JSON.stringify(urls) : null;
}

export function parseStoredUrlList(value: unknown): string[] {
    return normalizeUrlList(value);
}

export const urlListColumnTransformer = {
    to: (value: string[] | null | undefined): string | null => serializeUrlList(value),
    from: (value: unknown): string[] => parseStoredUrlList(value),
};

import {
  DEFAULT_MEDIA_VISIBILITY,
  hasPublicSharePermission,
  isPublicMediaVisibility,
  normalizeMediaVisibility,
  persistSection8Visibility,
  PUBLIC_EVIDENCE_LOCKED_LABEL,
  resolveMediaVisibility,
} from './media-visibility.util';

describe('media-visibility.util', () => {
  it('maps legacy Institutional/Private values onto Restricted/Private', () => {
    expect(normalizeMediaVisibility('limited')).toBe('restricted');
    expect(normalizeMediaVisibility('institutional')).toBe('restricted');
    expect(normalizeMediaVisibility('internal')).toBe('private');
    expect(normalizeMediaVisibility('restricted')).toBe('restricted');
    expect(normalizeMediaVisibility('private')).toBe('private');
    expect(normalizeMediaVisibility('public')).toBe('public');
    expect(normalizeMediaVisibility('')).toBe('');
  });

  it('defaults empty visibility to Restricted', () => {
    expect(resolveMediaVisibility('')).toBe(DEFAULT_MEDIA_VISIBILITY);
    expect(resolveMediaVisibility(undefined)).toBe('restricted');
  });

  it('requires an explicit public-share flag for new Public evidence', () => {
    expect(isPublicMediaVisibility('public')).toBe(true);
    expect(hasPublicSharePermission({ public_share_permission: true })).toBe(
      true,
    );
    expect(hasPublicSharePermission({ public_share_permission: false })).toBe(
      false,
    );
    expect(
      hasPublicSharePermission({
        ethical_compliance: { privacy_respected: true },
      }),
    ).toBe(true);
  });

  it('persists canonical keys and clears the public flag when not Public', () => {
    expect(
      persistSection8Visibility({
        media_visible: 'limited',
        public_share_permission: true,
      }),
    ).toEqual({
      media_visible: 'restricted',
      media_usage: 'restricted',
      public_share_permission: false,
    });
    expect(persistSection8Visibility({ has_evidence: 'no' })).toEqual({
      has_evidence: 'no',
      media_visible: 'restricted',
      media_usage: 'restricted',
      public_share_permission: false,
    });
    expect(
      persistSection8Visibility({
        media_visible: 'public',
        ethical_compliance: { privacy_respected: true },
      }),
    ).toEqual({
      media_visible: 'public',
      media_usage: 'public',
      ethical_compliance: { privacy_respected: true },
      public_share_permission: true,
    });
    expect(PUBLIC_EVIDENCE_LOCKED_LABEL).toContain('not publicly available');
  });
});

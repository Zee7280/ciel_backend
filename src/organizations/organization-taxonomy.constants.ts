/** Detailed organization sector — separate from signup role bucket (`orgType`: university | ngo | corporate). */
export const ORGANIZATION_CATEGORIES = [
    'Corporate Organization',
    'Nonprofit Organization (NGO)',
    'Government Organization',
    'Development Organization',
    'Educational Institution',
    'Healthcare Organization',
    'Community Organization',
    'Religious & Welfare Organization',
    'Research Organization',
    'Media Organization',
    'Other',
] as const;

export type OrganizationCategory = (typeof ORGANIZATION_CATEGORIES)[number];

export const LEGAL_REGISTRATION_TYPES = [
    'Sole Proprietorship',
    'Partnership Firm',
    'Limited Liability Partnership (LLP)',
    'Private Limited Company',
    'Public Limited Company',
    'Small & Medium Enterprise (SME)',
    'Startup Company',
    'Nonprofit Organization (NGO)',
    'Foundation',
    'Trust',
    'Registered Society',
    'Community-Based Organization (CBO)',
    'Government Department',
    'Public Sector Organization',
    'Autonomous Government Body',
    'Development Agency',
    'International Organization',
    'Educational Institution',
    'Healthcare Institution',
    'Chamber of Commerce',
    'Trade Association',
    'Research Institute / Think Tank',
    'Religious Organization',
    'Welfare Organization',
    'Other',
] as const;

export type LegalRegistrationType = (typeof LEGAL_REGISTRATION_TYPES)[number];

export const ORGANIZATION_CATEGORY_SET = new Set<string>(ORGANIZATION_CATEGORIES);
export const LEGAL_REGISTRATION_TYPE_SET = new Set<string>(LEGAL_REGISTRATION_TYPES);

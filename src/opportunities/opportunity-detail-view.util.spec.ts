import {
    buildOpportunityDetailView,
    previewLongText,
    splitNumberedDescriptionItems,
    STUDENT_RESPONSIBILITIES_MAX_LENGTH,
} from './opportunity-detail-view.util';
import { Opportunity } from './entities/opportunity.entity';

describe('opportunity-detail-view.util', () => {
    it('splits numbered objective lines', () => {
        const items = splitNumberedDescriptionItems('1-First goal\n2-Second goal');
        expect(items.length).toBe(2);
    });

    it('previews long responsibilities', () => {
        const long = 'A'.repeat(3000);
        const r = previewLongText(long, 500);
        expect(r.isLong).toBe(true);
        expect(r.preview.length).toBeLessThan(long.length);
    });

    it('builds partner and faculty blocks from supervision json', () => {
        const opp = {
            title: 'UpliftED',
            types: ['Community Service'],
            mode: 'Hybrid',
            visibility: 'restricted',
            timeline: { type: 'Ongoing', expected_hours: 16, volunteers_required: 20 },
            location: { city: 'Lahore', venue: 'Johar Town' },
            objectives: { description: '1-Goal one', beneficiaries_count: 60, beneficiaries_type: ['Children'] },
            sdg_info: { sdg_id: '4', target_id: '4.2', indicator_id: '4.2.2' },
            secondary_sdgs: [],
            activity_details: { student_responsibilities: 'Short plan', skills_gained: ['Teaching'] },
            supervision: {
                supervisor_name: 'Imran Khan',
                contact: 'imran@bnu.edu.pk',
                faculty_department: 'Education',
                partner_org_name: 'Rukh Foundation',
                partner_contact_person: 'Mam Rukhsana',
                partner_email: 'partner@test.com',
                whatsapp_e164: '+923001234567',
                safe_environment: true,
                supervised: true,
            },
            participation_scope: { rule: 'own_university_only' },
            verification_method: ['Photos of activities'],
        } as unknown as Opportunity;

        const view = buildOpportunityDetailView(opp);
        expect(view.supervision.faculty.name).toBe('Imran Khan');
        expect(view.supervision.partner.organization).toBe('Rukh Foundation');
        expect(view.objectives.description_items.length).toBeGreaterThanOrEqual(1);
    });

    it('surfaces an optional WhatsApp contact for the primary supervision contact, null when absent', () => {
        const withWhatsapp = {
            title: 'UpliftED',
            types: ['Community Service'],
            mode: 'Hybrid',
            timeline: {},
            location: {},
            objectives: {},
            sdg_info: {},
            secondary_sdgs: [],
            activity_details: {},
            supervision: {
                supervisor_name: 'Imran Khan',
                contact: 'imran@bnu.edu.pk',
                whatsapp_e164: '+923001234567',
            },
            participation_scope: {},
            verification_method: [],
        } as unknown as Opportunity;

        const view = buildOpportunityDetailView(withWhatsapp);
        expect(view.supervision.faculty.whatsapp).toBe('+923001234567');

        const withoutWhatsapp = {
            ...withWhatsapp,
            supervision: { supervisor_name: 'Imran Khan', contact: 'imran@bnu.edu.pk' },
        } as unknown as Opportunity;
        const bareView = buildOpportunityDetailView(withoutWhatsapp);
        expect(bareView.supervision.faculty.whatsapp).toBeNull();
    });

    it('exports responsibilities max length constant', () => {
        expect(STUDENT_RESPONSIBILITIES_MAX_LENGTH).toBeGreaterThan(1000);
    });
});

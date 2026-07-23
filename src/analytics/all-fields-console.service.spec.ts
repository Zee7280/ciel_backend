import { consoleRoleToStakeholder } from './all-fields-console.service';

describe('AllFieldsConsole role mapping', () => {
  it('maps console roles onto existing stakeholders', () => {
    expect(consoleRoleToStakeholder('student')).toBe('student');
    expect(consoleRoleToStakeholder('faculty')).toBe('university');
    expect(consoleRoleToStakeholder('university')).toBe('university');
    expect(consoleRoleToStakeholder('partner')).toBe('partner');
    expect(consoleRoleToStakeholder('unhec')).toBe('un_government');
  });
});

import {
  CATALOG_APPLY_CLOSED_MESSAGE,
  DEFAULT_STUDENT_APPLY_MAINTENANCE_MESSAGE,
  decorateApplyGate,
  parseApplyMaintenanceMessage,
  parseBooleanSettingValue,
  parseClosedBeforeSettingValue,
} from './student-apply-maintenance.util';

describe('student apply maintenance util', () => {
  const openState = {
    maintenanceEnabled: false,
    maintenanceMessage: DEFAULT_STUDENT_APPLY_MAINTENANCE_MESSAGE,
    closedBefore: null as Date | null,
    expiredMessage: CATALOG_APPLY_CLOSED_MESSAGE,
  };

  it('parses boolean flags', () => {
    expect(parseBooleanSettingValue('true', false)).toBe(true);
    expect(parseBooleanSettingValue('off', true)).toBe(false);
    expect(parseBooleanSettingValue('', false)).toBe(false);
  });

  it('falls back to the default maintenance message', () => {
    expect(parseApplyMaintenanceMessage('  ')).toBe(
      DEFAULT_STUDENT_APPLY_MAINTENANCE_MESSAGE,
    );
    expect(parseApplyMaintenanceMessage('Paused until Monday.')).toBe(
      'Paused until Monday.',
    );
  });

  it('blocks apply when maintenance is on, even for new listings', () => {
    const gate = decorateApplyGate(
      { createdAt: new Date('2026-12-01T00:00:00.000Z') },
      {
        ...openState,
        maintenanceEnabled: true,
        maintenanceMessage: 'Paused until Monday.',
      },
    );
    expect(gate.applications_open).toBe(false);
    expect(gate.apply_blocked_reason).toBe('maintenance');
    expect(gate.apply_blocked_message).toBe('Paused until Monday.');
  });

  it('blocks listings created on or before the catalog cutoff', () => {
    const closedBefore = parseClosedBeforeSettingValue(
      '2026-10-01T12:00:00.000Z',
    );
    const gate = decorateApplyGate(
      { createdAt: '2026-09-15T00:00:00.000Z' },
      { ...openState, closedBefore },
    );
    expect(gate.applications_open).toBe(false);
    expect(gate.apply_blocked_reason).toBe('catalog_closed');
    expect(gate.apply_blocked_message).toBe(CATALOG_APPLY_CLOSED_MESSAGE);
  });

  it('uses the admin expired message for cutoff listings', () => {
    const closedBefore = parseClosedBeforeSettingValue(
      '2026-10-01T12:00:00.000Z',
    );
    const gate = decorateApplyGate(
      { createdAt: '2026-09-15T00:00:00.000Z' },
      {
        ...openState,
        closedBefore,
        expiredMessage: 'This listing is expired until further notice.',
      },
    );
    expect(gate.apply_blocked_reason).toBe('catalog_closed');
    expect(gate.apply_blocked_message).toBe(
      'This listing is expired until further notice.',
    );
  });

  it('keeps newer listings open when maintenance is off', () => {
    const gate = decorateApplyGate(
      { createdAt: '2026-10-02T00:00:00.000Z' },
      {
        ...openState,
        closedBefore: new Date('2026-10-01T12:00:00.000Z'),
      },
    );
    expect(gate.applications_open).toBe(true);
    expect(gate.apply_blocked_reason).toBeNull();
  });
});

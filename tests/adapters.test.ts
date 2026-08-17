import { describe, expect, it } from 'vitest';
import { adapters, getAdapter, AdapterDisabledError, type AdapterName } from '@omnios/shared';

/**
 * Every integration in this build is a placeholder. The promise is:
 * they can describe what they WOULD do, and they cannot do it.
 * These tests hold that line, so no future change quietly enables a
 * live send.
 */
const names = Object.keys(adapters) as AdapterName[];

describe('adapter inventory', () => {
  it('covers the planned integrations', () => {
    expect(names).toEqual(
      expect.arrayContaining(['outlook', 'google_drive', 'google_calendar', 'finance_data', 'github']),
    );
  });

  for (const name of names) {
    it(`${name} is disabled`, () => {
      expect(getAdapter(name).enabled).toBe(false);
    });
  }
});

describe('adapters refuse to act', () => {
  for (const name of names) {
    it(`${name}.execute() throws instead of reaching an external system`, async () => {
      const adapter = getAdapter(name);
      const action = {
        actionType: adapter.supportedActions[0] ?? 'send_message',
        target: 'test-target',
        payload: { to: 'nobody@example.com', subject: 'test', body: 'test' },
      };
      await expect(adapter.execute(action)).rejects.toBeInstanceOf(AdapterDisabledError);
    });
  }
});

describe('adapters can still describe', () => {
  it('produces a preview that states nothing has been sent', () => {
    const p = adapters.outlook.preview({
      actionType: 'send_message',
      target: 'someone@example.com',
      payload: { to: 'someone@example.com', subject: 'Hello', body: 'Body text' },
    });
    expect(p.preview).toContain('someone@example.com');
    expect(p.preview).toContain('Hello');
    expect(p.preview.toLowerCase()).toContain('nothing has been sent');
  });

  it('includes the literal payload so the approval card can show it verbatim', () => {
    const payload = { to: 'a@b.com', subject: 'S', body: 'B' };
    const p = adapters.outlook.preview({ actionType: 'send_message', target: 'a@b.com', payload });
    expect(p.payload).toEqual(payload);
  });

  it('every adapter returns a non-empty preview for its supported actions', () => {
    for (const name of names) {
      const adapter = getAdapter(name);
      for (const actionType of adapter.supportedActions) {
        const p = adapter.preview({ actionType, target: 'x', payload: {} });
        expect(p.preview.length).toBeGreaterThan(20);
        expect(p.actionType).toBe(actionType);
      }
    }
  });
});

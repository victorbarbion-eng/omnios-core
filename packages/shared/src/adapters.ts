/**
 * Integration adapters — Step 7.
 *
 * These exist so the shape of a future integration is decided now,
 * while every live capability stays switched off. Each adapter can
 * describe what it WOULD do (which becomes the approval preview) and
 * refuses to actually do it.
 *
 * Enabling one later means: implement execute(), register its action
 * type in action_policies, and leave it approval_required until you
 * have watched it produce correct previews.
 */

export interface AdapterAction {
  /** Must match an action_type row in action_policies. */
  actionType: string;
  /** Stable, human-readable identifier of what is being touched. */
  target: string;
  /** The literal payload that would be sent. */
  payload: Record<string, unknown>;
}

export interface AdapterPreview {
  actionType: string;
  target: string;
  /** Exactly what would happen, in plain language, for the approval card. */
  preview: string;
  payload: Record<string, unknown>;
}

export class AdapterDisabledError extends Error {
  constructor(name: string, actionType: string) {
    super(
      `OMNIOS_ADAPTER_DISABLED: the "${name}" adapter is a placeholder in this build and cannot perform "${actionType}". ` +
        `It can only produce a preview for an approval request.`,
    );
    this.name = 'AdapterDisabledError';
  }
}

export abstract class IntegrationAdapter {
  abstract readonly name: string;
  abstract readonly enabled: boolean;
  abstract readonly supportedActions: readonly string[];

  abstract preview(action: AdapterAction): AdapterPreview;

  /** Placeholder adapters throw. Nothing reaches an external system. */
  async execute(action: AdapterAction): Promise<never> {
    throw new AdapterDisabledError(this.name, action.actionType);
  }
}

class OutlookAdapter extends IntegrationAdapter {
  readonly name = 'outlook';
  readonly enabled = false;
  readonly supportedActions = ['draft_message', 'send_message'] as const;

  preview(action: AdapterAction): AdapterPreview {
    const to = String(action.payload['to'] ?? '(no recipient)');
    const subject = String(action.payload['subject'] ?? '(no subject)');
    const body = String(action.payload['body'] ?? '');
    return {
      actionType: action.actionType,
      target: `outlook:${to}`,
      preview:
        `Send an email via Outlook.\n\nTo: ${to}\nSubject: ${subject}\n\nBody:\n${body}\n\n` +
        `Nothing has been sent. Approving performs this send exactly as shown.`,
      payload: action.payload,
    };
  }
}

class GoogleDriveAdapter extends IntegrationAdapter {
  readonly name = 'google_drive';
  readonly enabled = false;
  readonly supportedActions = ['modify_external_system'] as const;

  preview(action: AdapterAction): AdapterPreview {
    return {
      actionType: action.actionType,
      target: `drive:${String(action.payload['path'] ?? 'unknown')}`,
      preview:
        `Write to Google Drive at ${String(action.payload['path'] ?? 'unknown')}.\n` +
        `File: ${String(action.payload['name'] ?? 'untitled')}\n\nNothing has been written.`,
      payload: action.payload,
    };
  }
}

class CalendarAdapter extends IntegrationAdapter {
  readonly name = 'google_calendar';
  readonly enabled = false;
  readonly supportedActions = ['draft_calendar_event', 'modify_external_system'] as const;

  preview(action: AdapterAction): AdapterPreview {
    return {
      actionType: action.actionType,
      target: `calendar:${String(action.payload['calendar'] ?? 'primary')}`,
      preview:
        `Create a calendar event.\nTitle: ${String(action.payload['title'] ?? 'untitled')}\n` +
        `When: ${String(action.payload['start'] ?? '?')} → ${String(action.payload['end'] ?? '?')}\n\n` +
        `Nothing has been added to any calendar.`,
      payload: action.payload,
    };
  }
}

class FinanceDataAdapter extends IntegrationAdapter {
  readonly name = 'finance_data';
  readonly enabled = false;
  readonly supportedActions = ['read_source', 'financial_action'] as const;

  preview(action: AdapterAction): AdapterPreview {
    return {
      actionType: action.actionType,
      target: `finance:${String(action.payload['instrument'] ?? 'unknown')}`,
      preview:
        `Financial action on ${String(action.payload['instrument'] ?? 'unknown')}: ` +
        `${String(action.payload['side'] ?? '?')} ${String(action.payload['quantity'] ?? '?')}.\n\n` +
        `This build never executes trades. Paper positions only, and only after approval.`,
      payload: action.payload,
    };
  }
}

class GitHubAdapter extends IntegrationAdapter {
  readonly name = 'github';
  readonly enabled = false;
  readonly supportedActions = ['draft_pull_request', 'merge_pull_request'] as const;

  preview(action: AdapterAction): AdapterPreview {
    return {
      actionType: action.actionType,
      target: `github:${String(action.payload['repo'] ?? 'unknown')}#${String(action.payload['branch'] ?? '?')}`,
      preview:
        `${action.actionType === 'merge_pull_request' ? 'Merge' : 'Open a DRAFT pull request on'} ` +
        `${String(action.payload['repo'] ?? 'unknown')} from branch ${String(action.payload['branch'] ?? '?')}.\n` +
        `Title: ${String(action.payload['title'] ?? 'untitled')}\n\nNothing has been pushed or merged.`,
      payload: action.payload,
    };
  }
}

export const adapters = {
  outlook: new OutlookAdapter(),
  google_drive: new GoogleDriveAdapter(),
  google_calendar: new CalendarAdapter(),
  finance_data: new FinanceDataAdapter(),
  github: new GitHubAdapter(),
} as const;

export type AdapterName = keyof typeof adapters;

export function getAdapter(name: AdapterName): IntegrationAdapter {
  return adapters[name];
}

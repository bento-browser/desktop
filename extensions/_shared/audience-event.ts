import type { Event } from './protocol';

/**
 * A tools event for one audience of shell documents. The shell background fans
 * out by audience, so state of a private window's ephemeral "Private" workspace
 * (its tabs, workspace, panels) reaches only that window's documents and never a
 * regular one, and regular workspaces never reach a private window. An Event that
 * is not wrapped (settings, privacy, boot, saved panels) is global: it goes to
 * every document.
 */
export interface AudienceEvent {
  type: 'audience/event';
  /** `'regular'`: documents of regular windows. `{ privateWindowId }`: the
   * private documents of that window. */
  audience: 'regular' | { privateWindowId: number };
  event: Event;
}

export function isAudienceEvent(value: unknown): value is AudienceEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Partial<AudienceEvent>;
  const audience = message.audience as unknown;
  return (
    message.type === 'audience/event' &&
    (audience === 'regular' ||
      (typeof audience === 'object' &&
        audience !== null &&
        Number.isInteger((audience as { privateWindowId?: unknown }).privateWindowId))) &&
    typeof message.event === 'object' &&
    message.event !== null
  );
}

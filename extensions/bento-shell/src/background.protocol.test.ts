import { describe, expect, it } from 'vitest';
import { isShellClientMessage, isTargetedShellEvent } from '@shared/shell-client-protocol';

describe('shell client protocol ownership', () => {
  it('accepts one exact registration shape and rejects forged producer fields', () => {
    const registration = {
      type: 'shell-client/register',
      shellBackgroundInstanceId: crypto.randomUUID(),
      clientInstanceId: crypto.randomUUID(),
      mountToken: 'a'.repeat(64),
      role: 'primary',
      windowId: 4,
      audience: 'regular',
      registryRevision: 2,
    } as const;
    expect(isShellClientMessage(registration)).toBe(true);
    expect(
      isShellClientMessage({ ...registration, acceptedParentSessionId: crypto.randomUUID() }),
    ).toBe(false);
    expect(
      isShellClientMessage({
        type: 'shell-client/parent-session-attestation',
        currentBootId: crypto.randomUUID(),
      }),
    ).toBe(false);
  });

  it('requires exact targeted routing fields', () => {
    const envelope = {
      type: 'shell-client/event',
      shellBackgroundInstanceId: crypto.randomUUID(),
      targetClientInstanceId: crypto.randomUUID(),
      expectedRole: 'primary',
      expectedWindowId: 4,
      expectedAudience: 'regular',
      deliveryId: crypto.randomUUID(),
      event: {
        type: 'graph/resync-required',
        backendInstanceId: crypto.randomUUID(),
        publicationId: crypto.randomUUID(),
        graphRevision: 3,
        audience: { kind: 'regular' },
      },
    } as const;
    expect(isTargetedShellEvent(envelope)).toBe(true);
    expect(isTargetedShellEvent({ ...envelope, broadcast: true })).toBe(false);
  });
});

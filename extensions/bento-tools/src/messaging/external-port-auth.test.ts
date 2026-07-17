import { describe, expect, it } from 'vitest';
import { isAuthorizedShellPort } from './external-port-auth';

const SHELL_PORT_NAME = 'bento-shell<->bento-tools';
const SHELL_EXTENSION_ID = 'bento-shell@bento.app';

function port(name: string, senderId?: string) {
  return {
    name,
    sender: senderId ? { id: senderId } : undefined,
  } as Pick<browser.runtime.Port, 'name' | 'sender'>;
}

describe('isAuthorizedShellPort', () => {
  it('accepts the Bento Shell port', () => {
    expect(isAuthorizedShellPort(port(SHELL_PORT_NAME, SHELL_EXTENSION_ID))).toBe(true);
  });

  it('rejects another extension using the expected port name', () => {
    expect(isAuthorizedShellPort(port(SHELL_PORT_NAME, 'attacker@example.test'))).toBe(false);
  });

  it('rejects a missing sender identity', () => {
    expect(isAuthorizedShellPort(port(SHELL_PORT_NAME))).toBe(false);
  });

  it('rejects an unexpected port name from Bento Shell', () => {
    expect(isAuthorizedShellPort(port('unexpected', SHELL_EXTENSION_ID))).toBe(false);
  });
});

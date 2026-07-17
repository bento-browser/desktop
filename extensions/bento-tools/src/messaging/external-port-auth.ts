import { SHELL_TOOLS_PORT } from '@shared/protocol';

const BENTO_SHELL_EXTENSION_ID = 'bento-shell@bento.app';

type ExternalPortIdentity = Pick<browser.runtime.Port, 'name' | 'sender'>;

/** Only Bento Shell may reach the privileged tools action dispatcher. */
export function isAuthorizedShellPort(port: ExternalPortIdentity): boolean {
  return port.name === SHELL_TOOLS_PORT && port.sender?.id === BENTO_SHELL_EXTENSION_ID;
}

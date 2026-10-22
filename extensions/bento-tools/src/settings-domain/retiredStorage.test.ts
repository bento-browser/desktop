import { describe, expect, it, vi } from 'vitest';
import { removeRetiredSettingsStorage } from './retiredStorage';

describe('removeRetiredSettingsStorage', () => {
  it('removes the native session key and leaves the operation records', async () => {
    const storage: Record<string, unknown> = {
      'bento.nativeSessions.v1': { version: 1, sessions: [] },
      'bento.nativeOperations.v1': { version: 1, records: [] },
    };
    vi.stubGlobal('browser', {
      storage: {
        local: {
          remove: async (keys: string[]) => {
            for (const key of keys) delete storage[key];
          },
        },
      },
    });
    await removeRetiredSettingsStorage();
    expect(Object.keys(storage)).toEqual(['bento.nativeOperations.v1']);
    vi.unstubAllGlobals();
  });

  it('does not throw when storage refuses', async () => {
    vi.stubGlobal('browser', {
      storage: { local: { remove: async () => Promise.reject(new Error('quota')) } },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(removeRetiredSettingsStorage()).resolves.toBeUndefined();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});

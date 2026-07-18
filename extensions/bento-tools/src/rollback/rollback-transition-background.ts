import { GraphOperationRollbackAdapter } from './GraphOperationRollbackAdapter';
import { startLegacyRuntime } from './legacy-runtime';

type RecoveryRequest =
  | { type: 'rollback/status' }
  | { type: 'rollback/prepare-final'; confirm: true };

function isRecoveryRequest(value: unknown): value is RecoveryRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.type === 'rollback/status') return Object.keys(record).length === 1;
  return (
    record.type === 'rollback/prepare-final' &&
    record.confirm === true &&
    Object.keys(record).length === 2
  );
}

async function openRecoveryPage(): Promise<void> {
  const url = browser.runtime.getURL('dist/rollback.html');
  const existing = await browser.tabs.query({ url });
  if (existing.length === 0) await browser.tabs.create({ url, active: true });
}

void (async () => {
  const adapter = new GraphOperationRollbackAdapter();
  const outcome = await adapter.run();

  browser.runtime.onMessage.addListener((message: unknown, sender) => {
    if (sender.id !== browser.runtime.id || !isRecoveryRequest(message)) return undefined;
    if (message.type === 'rollback/status') {
      return Promise.resolve({ ok: true, prepared: false, record: adapter.getRecord() });
    }
    return adapter
      .prepareFinal()
      .then(() => ({ ok: true, prepared: true }))
      .catch((error: unknown) => ({
        ok: false,
        error: error instanceof Error ? error.message : 'prepare-final-failed',
      }));
  });

  if (outcome.ready) {
    await adapter.markLegacyRunning();
    await startLegacyRuntime();
    await adapter.markReadyForFinal();
  } else {
    console.error(
      '[bento-tools] rollback transition is blocked:',
      outcome.record.sanitizedErrorCode,
    );
  }
  await openRecoveryPage();
})();

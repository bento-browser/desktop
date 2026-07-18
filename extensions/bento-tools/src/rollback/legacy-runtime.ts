let started = false;

/** The variant builder resolves this import to its staged legacy source tree. */
export async function startLegacyRuntime(): Promise<void> {
  if (started) return;
  started = true;
  await import('../../.rollback-staging/src/background');
}

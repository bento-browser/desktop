import { describe, expect, it } from 'vitest';
import fixtures from '@shared/generated/native-preferences-protocol-fixtures.json';
import { validateEnvelope } from '@shared/generated/native-preferences-protocol';

describe('generated native preferences envelope validator', () => {
  it('accepts the canonical hello and authenticated fixtures', () => {
    expect(validateEnvelope(fixtures.validHelloEnvelope)).toBe(true);
    expect(validateEnvelope(fixtures.validAuthenticatedEnvelope)).toBe(true);
  });

  it('rejects unknown keys, malformed identity, tokens, and missing sequence', () => {
    expect(validateEnvelope({ ...fixtures.validHelloEnvelope, injected: true })).toBe(false);
    expect(
      validateEnvelope({ ...fixtures.validHelloEnvelope, clientInstanceId: 'not-a-uuid' }),
    ).toBe(false);
    expect(validateEnvelope({ ...fixtures.validAuthenticatedEnvelope, resumeToken: 'short' })).toBe(
      false,
    );
    const missingSequence: Record<string, unknown> = {
      ...fixtures.validAuthenticatedEnvelope,
    };
    delete missingSequence.sequence;
    expect(validateEnvelope(missingSequence)).toBe(false);
  });
});

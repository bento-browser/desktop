// What the BentoShellBus relay can carry up to tools. Kept out of `bridge/shellBus.ts`, which
// every shell document bundles, because only the Settings palette sends a payload this large.

/** The longest `bento-bus-up` string the child actor forwards (`MAX_MESSAGE_CHARS` in
 * BentoShellBusChild.sys.mjs; a test keeps the two equal). It limits the serialized message, in
 * which JSON escaping can double a payload's text, so it is sized for two times the largest
 * backup file (`SETTINGS_LIMITS.backupFileBytes`, 10 MiB) with 2 MiB to spare. */
export const RELAY_UP_MAX_CHARS = 22 * 1024 * 1024;

/** Room kept for the message around a payload (kind, ids, operation name). */
const RELAY_ENVELOPE_RESERVE_CHARS = 4096;

/** Whether text sent as one string field of an upward message reaches tools, or the actor drops
 * the whole message without an answer. */
export function fitsRelayUp(text: string): boolean {
  return JSON.stringify(text).length + RELAY_ENVELOPE_RESERVE_CHARS <= RELAY_UP_MAX_CHARS;
}

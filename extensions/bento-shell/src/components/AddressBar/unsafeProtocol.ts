const SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):/i;

function leadingAsciiWhitespaceAndControlLength(value: string): number {
  let index = 0;
  while (index < value.length && value.charCodeAt(index) <= 0x20) index += 1;
  return index;
}

export function stripUnsafeProtocolOnPaste(value: string): string {
  let sanitized = value;
  for (;;) {
    const prefixLength = leadingAsciiWhitespaceAndControlLength(sanitized);
    const match = SCHEME_PATTERN.exec(sanitized.slice(prefixLength));
    if (!match || match[1]?.toLowerCase() !== 'javascript') return sanitized;
    sanitized = sanitized.slice(prefixLength + match[0].length);
  }
}

export function replaceSelectionWithSafePaste(
  value: string,
  selectionStart: number | null,
  selectionEnd: number | null,
  pasted: string,
): { value: string; cursor: number; changed: boolean } {
  const sanitized = stripUnsafeProtocolOnPaste(pasted);
  const start = selectionStart ?? value.length;
  const end = selectionEnd ?? start;
  return {
    value: value.slice(0, start) + sanitized + value.slice(end),
    cursor: start + sanitized.length,
    changed: sanitized !== pasted,
  };
}

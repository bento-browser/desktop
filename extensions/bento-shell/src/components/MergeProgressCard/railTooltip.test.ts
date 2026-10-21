import { describe, expect, it, vi } from 'vitest';
import { createRailTooltipSignal, railTooltipTitle } from './railTooltip';

const anchor = { left: 7.5, top: 754, width: 36, height: 36 };
const text = { label: 'Importing from Firefox', detail: 'Work, 120 of 608 tabs' };

/** Decodes a payload title the way chrome does: base64 of UTF-8 JSON after the timestamp. */
function decode(title: string): unknown {
  const [, , encoded] = title.split(':');
  return JSON.parse(Buffer.from(encoded!, 'base64').toString('utf8'));
}

describe('railTooltipTitle', () => {
  it('carries the action, the text and the anchor under the BENTO_RAIL_TOOLTIP prefix', () => {
    const title = railTooltipTitle({ action: 'hover', ...text, anchor }, 123);
    expect(title.startsWith('BENTO_RAIL_TOOLTIP:123:')).toBe(true);
    expect(decode(title)).toEqual({ action: 'hover', ...text, anchor });
  });

  it('keeps non-ASCII text intact', () => {
    const title = railTooltipTitle({ action: 'focus', label: 'Importé', detail: null, anchor }, 1);
    expect(decode(title)).toMatchObject({ label: 'Importé', detail: null });
  });

  it('needs only the action to hide', () => {
    expect(decode(railTooltipTitle({ action: 'hide' }, 1))).toEqual({ action: 'hide' });
  });
});

describe('createRailTooltipSignal', () => {
  it('sends a show, then one hide', () => {
    const send = vi.fn();
    const signal = createRailTooltipSignal(send);
    expect(signal.active).toBe(false);

    signal.show('hover', text, anchor);
    expect(signal.active).toBe(true);
    expect(decode(send.mock.calls[0]![0])).toMatchObject({ action: 'hover', label: text.label });

    signal.hide();
    signal.hide();
    expect(send).toHaveBeenCalledTimes(2);
    expect(decode(send.mock.calls[1]![0])).toEqual({ action: 'hide' });
    expect(signal.active).toBe(false);
  });

  it('sends nothing to hide a tooltip that was never shown', () => {
    const send = vi.fn();
    createRailTooltipSignal(send).hide();
    expect(send).not.toHaveBeenCalled();
  });

  it('shows again after a hide', () => {
    const send = vi.fn();
    const signal = createRailTooltipSignal(send);
    signal.show('focus', text, anchor);
    signal.hide();
    signal.show('focus', text, anchor);
    expect(send).toHaveBeenCalledTimes(3);
    expect(signal.active).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import type { BentoSettings } from '@shared/protocol';
import { PrivateWindowSettings } from './privateWindowSettings';

const saved = (uiColorMode: BentoSettings['uiColorMode'], sidebarCollapsed = false) =>
  ({
    uiColorMode,
    sidebarCollapsed,
    sidebarHidden: false,
    panelCornerRadiusPx: 6,
  }) as BentoSettings;

describe('PrivateWindowSettings', () => {
  it('starts a window that opened before any settings from the first saved ones', () => {
    const settings = new PrivateWindowSettings();
    settings.open(3);
    expect(settings.view(3, null)).toBeNull();

    settings.saved(saved('dark', true));
    settings.saved(saved('light'));

    expect(settings.view(3, saved('light'))).toMatchObject({
      uiColorMode: 'dark',
      sidebarCollapsed: true,
    });
  });

  it('passes the saved settings through for a window it does not know', () => {
    const settings = new PrivateWindowSettings();
    settings.saved(saved('dark'));
    const regular = saved('light');

    expect(settings.view(5, regular)).toBe(regular);
    expect(settings.update(5, { sidebarCollapsed: true })).toBeNull();
  });
});

// Window-local sidebar state of the private windows, kept in the shell
// background's memory.
//
// A private window's sidebar collapse, hidden state and colour mode are its own:
// they start from the saved values when the window opens, change independently of
// every other window, and are never saved. The saved settings stay the regular
// windows' shared state.
//
// Every document of a private window then sees the settings with these three
// values replaced by the window's own (`view`), which is also what the sidebar
// document hands to chrome in the BENTO_PANELS payload.

import type { BentoSettings } from '@shared/protocol';
import { pickWindowLocalSettings, type WindowLocalSettings } from '@shared/windowLocalSettings';

export class PrivateWindowSettings {
  #saved: BentoSettings | null = null;
  #byWindow = new Map<number, WindowLocalSettings>();
  /** Windows that opened before the first saved settings arrived. */
  #unseeded = new Set<number>();

  /** Records the latest saved settings. Open windows keep their own values; a window
   * that opened before any settings were known starts from these. */
  saved(settings: BentoSettings): void {
    this.#saved = settings;
    for (const windowId of this.#unseeded) {
      this.#byWindow.set(windowId, pickWindowLocalSettings(settings));
    }
    this.#unseeded.clear();
  }

  /** A private window opened: it starts from the saved values as they are now. */
  open(windowId: number): void {
    if (this.#byWindow.has(windowId) || this.#unseeded.has(windowId)) return;
    if (this.#saved) this.#byWindow.set(windowId, pickWindowLocalSettings(this.#saved));
    else this.#unseeded.add(windowId);
  }

  close(windowId: number): void {
    this.#byWindow.delete(windowId);
    this.#unseeded.delete(windowId);
  }

  /** Applies a window's own change. Returns the settings that window now sees, or
   * null when the window or the saved settings are not known yet. */
  update(windowId: number, changes: Partial<WindowLocalSettings>): BentoSettings | null {
    const own = this.#byWindow.get(windowId);
    if (!own) return null;
    this.#byWindow.set(windowId, { ...own, ...changes });
    return this.view(windowId, this.#saved);
  }

  /** The window's own values, or undefined while it is not known yet. */
  own(windowId: number): WindowLocalSettings | undefined {
    return this.#byWindow.get(windowId);
  }

  /** `settings` as the window sees them: its own values over the saved ones. */
  view(windowId: number, settings: BentoSettings | null): BentoSettings | null {
    const own = this.#byWindow.get(windowId);
    return settings && own ? { ...settings, ...own } : settings;
  }
}

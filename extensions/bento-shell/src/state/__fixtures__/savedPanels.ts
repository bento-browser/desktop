// Fake "Saved panels" bookmark data for Ladle stories — seeds
// useSavedPanelsStore so PanelTrailer can be exercised in isolation
// without bento-tools or the WebExtension bookmarks API.

import type { SavedPanelEntry } from '@shared/protocol';
import { useSavedPanelsStore } from '../savedPanels';

export const SAMPLE_SAVED_PANELS: SavedPanelEntry[] = [
  { id: 'fixture-1', title: 'ChatGPT', url: 'https://chat.openai.com/' },
  { id: 'fixture-2', title: 'Linear · Inbox', url: 'https://linear.app/inbox' },
  { id: 'fixture-3', title: 'Hacker News', url: 'https://news.ycombinator.com/' },
];

export const MANY_SAVED_PANELS: SavedPanelEntry[] = [
  ...SAMPLE_SAVED_PANELS,
  { id: 'fixture-4', title: 'GitHub Notifications', url: 'https://github.com/notifications' },
  { id: 'fixture-5', title: 'Figma · Bento', url: 'https://figma.com/file/bento' },
  { id: 'fixture-6', title: 'Notion · Daily', url: 'https://notion.so/daily' },
  { id: 'fixture-7', title: 'Slack', url: 'https://slack.com/' },
  { id: 'fixture-8', title: 'Calendar', url: 'https://calendar.google.com/' },
  { id: 'fixture-9', title: 'YouTube', url: 'https://youtube.com/' },
  { id: 'fixture-10', title: 'X (Twitter)', url: 'https://x.com/' },
  {
    id: 'fixture-11',
    title:
      'A very long bookmark title that should still render readably inside the Tale UI tooltip popup',
    url: 'https://example.com/long-title',
  },
  { id: 'fixture-12', title: 'Bento Settings', url: 'https://bento-browser.com/settings' },
];

export function seedSavedPanels(items: SavedPanelEntry[]): void {
  useSavedPanelsStore.getState().apply(items);
}

export function seedEmptySavedPanels(): void {
  useSavedPanelsStore.getState().apply([]);
}

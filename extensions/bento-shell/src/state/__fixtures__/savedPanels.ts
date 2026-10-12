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
      'A very long bookmark title that should still render readably inside the Bento tooltip popup',
    url: 'https://example.com/long-title',
  },
  { id: 'fixture-12', title: 'Bento Settings', url: 'https://bento-browser.com/settings' },
];

// Square-cornered SVG favicons: the trailer's favicon radius is the only thing
// that rounds them, so a missing radius shows as sharp corners.
function squareFavicon(fill: string, letter: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="${fill}"/>` +
    `<text x="12" y="17" font-size="14" font-family="sans-serif" text-anchor="middle" fill="#fff">${letter}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export const FAVICON_SAVED_PANELS: SavedPanelEntry[] = [
  {
    id: 'fixture-icon-1',
    title: 'ChatGPT',
    url: 'https://chat.openai.com/',
    favIconUrl: squareFavicon('#10a37f', 'C'),
  },
  {
    id: 'fixture-icon-2',
    title: 'Linear · Inbox',
    url: 'https://linear.app/inbox',
    favIconUrl: squareFavicon('#5e6ad2', 'L'),
  },
  {
    id: 'fixture-icon-3',
    title: 'Hacker News',
    url: 'https://news.ycombinator.com/',
    favIconUrl: squareFavicon('#ff6600', 'H'),
  },
];

export function seedSavedPanels(items: SavedPanelEntry[]): void {
  useSavedPanelsStore.getState().apply(items);
}

export function seedEmptySavedPanels(): void {
  useSavedPanelsStore.getState().apply([]);
}

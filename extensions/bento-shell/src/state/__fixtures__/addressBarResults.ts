import type { AddrResult } from '@shared/protocol';
import { useAddressBarStore } from '../addressBar';

export const SAMPLE_ADDRESS_RESULTS: AddrResult[] = [
  {
    kind: 'history',
    url: 'https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/history/search',
    title: 'history.search() - Mozilla | MDN',
    score: 1200,
  },
  {
    kind: 'bookmark',
    url: 'https://github.com/Bento-Browser/bento-browser',
    title: 'Bento Browser repository',
    score: 1100,
  },
  {
    kind: 'history',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    title: 'A very long video title that should truncate cleanly in the floating address bar',
    score: 900,
  },
];

export function seedAddressBarResults(query = 'bento'): void {
  useAddressBarStore.getState().seed(query, SAMPLE_ADDRESS_RESULTS);
}

export function seedEmptyAddressBarResults(): void {
  useAddressBarStore.getState().clear();
}

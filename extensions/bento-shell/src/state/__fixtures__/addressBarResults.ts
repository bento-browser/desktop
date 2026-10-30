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

export function seedGroupedAddressBarResults(): void {
  const now = Date.now();
  useAddressBarStore.getState().seed('', [
    {
      kind: 'recentlyClosed',
      sessionId: 'fixture-closed-1',
      url: 'https://design.example/navigation',
      title: 'Navigation patterns',
      closedAt: now - 120_000,
      score: 0,
    },
    {
      kind: 'recentlyClosed',
      sessionId: 'fixture-closed-2',
      url: 'https://docs.example/grid',
      title: 'CSS grid guide',
      closedAt: now - 720_000,
      score: 0,
    },
    {
      kind: 'recentHistory',
      url: 'https://roadmap.example/',
      title: 'Bento roadmap',
      lastVisitTime: now - 240_000,
      score: 0,
    },
    {
      kind: 'recentHistory',
      url: 'https://motion.example/springs',
      title: 'Spring animations',
      lastVisitTime: now - 1_080_000,
      score: 0,
    },
    { kind: 'topSite', url: 'https://code.example/', title: 'Code', score: 2 },
    { kind: 'topSite', url: 'https://encyclopedia.example/', title: 'Encyclopedia', score: 1 },
  ]);
}

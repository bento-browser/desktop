import { create } from 'zustand';
import type { AddrResult } from '@shared/protocol';

interface AddressBarState {
  query: string;
  results: AddrResult[];
  applyResults: (query: string, results: AddrResult[]) => void;
  seed: (query: string, results: AddrResult[]) => void;
  clear: () => void;
}

export const useAddressBarStore = create<AddressBarState>((set) => ({
  query: '',
  results: [],
  applyResults: (query, results) => set({ query, results }),
  seed: (query, results) => set({ query, results }),
  clear: () => set({ query: '', results: [] }),
}));

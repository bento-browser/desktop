import { create } from 'zustand';

interface SidebarCardsState {
  /**
   * How far the floating sidebar cards reach up from the bottom of the tab list, in px:
   * their height plus the offset above the footer and the gap kept below the last row.
   * 0 while no card shows. The tab list pads its end by this much so the last rows can
   * scroll clear of the cards.
   */
  inset: number;
  setInset: (inset: number) => void;
}

export const useSidebarCardsStore = create<SidebarCardsState>((set) => ({
  inset: 0,
  setInset: (inset) => set((state) => (state.inset === inset ? state : { inset })),
}));

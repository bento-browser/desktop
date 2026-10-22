// Tells the palette when it was shown. The overlay document stays loaded while chrome hides it,
// so every show has to start fresh from the document's side: back at the root with the latest
// snapshot. Chrome will send an explicit open message when the overlay is wired in; until
// then a document that turns visible again counts as a show, and gaining focus only refreshes
// the snapshot (the user may have changed a setting elsewhere).

import { useEffect, useState } from 'react';

/** Returns a number that changes on each show. `refresh` runs on mount, on each show and on focus. */
export function useShowSignal(refresh: () => void): number {
  const [shown, setShown] = useState(0);

  useEffect(() => {
    refresh();
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      setShown((count) => count + 1);
      refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);

  return shown;
}

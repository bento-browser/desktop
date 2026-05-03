// Typed wrapper around the bento-shell ↔ bento-tools long-lived port.
// M0 scope: just expose the port object. M1+ wires it into Zustand as a
// reactive subscription per §4.2 of the plan (UI dispatches Actions; tools
// broadcasts Events; shell stores apply deltas).

import { useEffect, useState } from 'react';
import type { Action, Event } from '@shared/protocol';
import { SHELL_TOOLS_PORT } from '@shared/protocol';

export interface ToolsPort {
  send: (action: Action) => void;
  /** Last event received from tools — handy for early-stage debugging. */
  lastEvent: Event | null;
  /** False until tools acknowledges the connection. */
  ready: boolean;
}

export function useToolsPort(): ToolsPort {
  const [lastEvent, setLastEvent] = useState<Event | null>(null);
  const [ready, setReady] = useState(false);
  const [port, setPort] = useState<browser.runtime.Port | null>(null);

  useEffect(() => {
    if (typeof browser === 'undefined' || !browser.runtime?.connect) {
      // Standalone Vite dev server — no browser.* API available.
      // M1: the bridge/ mock layer will provide a fake port.
      return;
    }

    const p = browser.runtime.connect('bento-tools@bento.app', {
      name: SHELL_TOOLS_PORT,
    });
    setPort(p);

    p.onMessage.addListener((message: object) => {
      const event = message as Event;
      setLastEvent(event);
      if (event.type === 'tools/booted') setReady(true);
    });

    return () => p.disconnect();
  }, []);

  return {
    send: (action) => port?.postMessage(action),
    lastEvent,
    ready,
  };
}

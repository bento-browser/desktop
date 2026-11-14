// Workspace layers overlay entry: one chrome-mounted document for the workspace switcher menu,
// the edit-workspace dialog and the confirmation dialog, so a window keeps one resident document
// for the three instead of three (docs/technical/overlay-documents.md, "Workspace layers
// document"). Chrome creates it at window startup: the sidebar and the workspace palette post
// these layers' payloads document to document, with no queue.
//
// The layers mount on show, one at a time (layers.ts). A dialog that stayed open in a shared
// document would have React Aria hide and trap everything outside it, the other layers included.

import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

// First: the layers below import the primitives, which load BentoStack.css, and the layer order
// is set by whichever stylesheet the dev server injects first.
import '../theme/muxui.css';
import '../theme/bento-tokens.css';
import '../theme/presets/index.css';
import '../theme/bento-fonts.css';
import '../theme/document-base.css';
import { useFirefoxTheme } from '../theme/useFirefoxTheme';
import { useWorkspaceTheme } from '../theme/useWorkspaceTheme';
import { initToolsPort } from '../bridge/useToolsPort';
import { subscribeToConfirmRequests } from '../bridge/useConfirm';
import { subscribeToEditWorkspaceRequests } from '../bridge/useEditWorkspace';
import {
  notifyWorkspaceSwitcherClosed,
  subscribeToWorkspaceSwitcherRequests,
} from '../bridge/useWorkspaceSwitcher';
import { useOverlayReadySignal } from '../bridge/overlayReady';
import {
  observeWorkspaceLayersPresentation,
  showWorkspaceLayer,
  useVisibleWorkspaceLayer,
} from './layers';
import { SwitcherLayer } from './SwitcherLayer';
import { EditWorkspaceLayer } from './EditWorkspaceLayer';
import { ConfirmLayer } from './ConfirmLayer';

initToolsPort({ families: ['tabs', 'workspaces', 'settings', 'panels'] });

// From the first presentation on, before the document announces that it is ready.
observeWorkspaceLayersPresentation((layer) => {
  // Chrome hid the switcher without the menu closing itself (Esc, which chrome takes first):
  // the sidebar trigger still shows it open.
  if (layer === 'workspace-switcher') notifyWorkspaceSwitcherClosed();
});

function WorkspaceLayersApp() {
  useFirefoxTheme({ preferStoredSystemResolution: true });
  useWorkspaceTheme();
  const request = useVisibleWorkspaceLayer();

  useEffect(() => {
    const unsubscribers = [
      subscribeToWorkspaceSwitcherRequests((payload, id) =>
        showWorkspaceLayer({ layer: 'workspace-switcher', id, payload }),
      ),
      subscribeToEditWorkspaceRequests((payload, id) =>
        showWorkspaceLayer({ layer: 'edit-workspace', id, payload }),
      ),
      subscribeToConfirmRequests((payload, id) =>
        showWorkspaceLayer({ layer: 'confirm', id, payload }),
      ),
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, []);
  // After the subscriptions: one announcement for the document and its three layers.
  useOverlayReadySignal('workspace-layers');

  if (!request) return null;
  // Keyed by request, so every open mounts its layer afresh (drafts, focus, Mux entrance).
  switch (request.layer) {
    case 'workspace-switcher':
      return <SwitcherLayer key={request.id} requestId={request.id} payload={request.payload} />;
    case 'edit-workspace':
      return <EditWorkspaceLayer key={request.id} payload={request.payload} />;
    case 'confirm':
      return <ConfirmLayer key={request.id} payload={request.payload} />;
  }
}

const container = document.getElementById('root');
if (!container) throw new Error('bento-shell workspace-layers: #root not found');

createRoot(container).render(
  <StrictMode>
    <WorkspaceLayersApp />
  </StrictMode>,
);

// Visual states for the PrivateBand: the mark of a private window's sidebar. Expanded,
// with its note open, and as the glyph-only block in the narrow rail (where the note shows
// in the chrome-side tooltip overlay, which Ladle does not have). The rail look follows
// data-bento-collapsed on <html>, as the real shell sets it from its own width.
import { useEffect } from 'react';

import { PrivateBand } from './PrivateBand';
import '../../app.css';

const COLLAPSED_SIDEBAR_WIDTH = 'var(--bento-tab-strip-width-collapsed)';

function SidebarFrame({
  children,
  collapsed = false,
  width = 300,
}: {
  children: React.ReactNode;
  collapsed?: boolean;
  width?: number;
}) {
  useEffect(() => {
    const html = document.documentElement;
    if (collapsed) html.setAttribute('data-bento-collapsed', 'true');
    else html.removeAttribute('data-bento-collapsed');
    return () => html.removeAttribute('data-bento-collapsed');
  }, [collapsed]);
  return (
    <div
      className="bento-shell-app__workspace-switcher bento-shell-app__workspace-switcher--private"
      style={{
        width: collapsed ? COLLAPSED_SIDEBAR_WIDTH : width,
        minHeight: 160,
        backgroundColor: 'var(--bento-brand-bg)',
      }}
    >
      {children}
    </div>
  );
}

export const Expanded = () => (
  <SidebarFrame>
    <PrivateBand />
  </SidebarFrame>
);

export const NoteOpen = () => (
  <SidebarFrame>
    <PrivateBand defaultNoteOpen />
  </SidebarFrame>
);

NoteOpen.storyName = 'Note open';

export const NarrowSidebar = () => (
  <SidebarFrame width={150}>
    <PrivateBand />
  </SidebarFrame>
);

NarrowSidebar.storyName = 'Narrow sidebar (text truncates)';

export const Rail = () => (
  <SidebarFrame collapsed>
    <PrivateBand rail />
  </SidebarFrame>
);

Rail.storyName = 'Collapsed rail (glyph only)';

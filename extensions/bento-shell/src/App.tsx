import { useEffect, useLayoutEffect, useRef } from 'react';
import { Column } from '@tale-ui/react/column';
import { Row } from '@tale-ui/react/row';
import { Text } from '@tale-ui/react/text';
import { IconButton } from '@tale-ui/react/icon-button';
import { Icon } from '@tale-ui/react/icon';
import Settings from 'lucide-react/dist/esm/icons/settings';
import Command from 'lucide-react/dist/esm/icons/command';
import PanelLeftClose from 'lucide-react/dist/esm/icons/panel-left-close';
import PanelLeftOpen from 'lucide-react/dist/esm/icons/panel-left-open';

import { TabList } from './components/TabList/TabList';
import { WorkspaceSwitcher } from './components/WorkspaceSwitcher/WorkspaceSwitcher';
import { ColorModeCycle } from './components/ColorModeCycle/ColorModeCycle';
import { dispatch, useToolsReady } from './bridge/useToolsPort';
import { requestWelcome } from './bridge/useWelcome';
import { useWorkspacesStore } from './state/workspaces';
import { useSettingsStore } from './state/settings';
import type { ColorModePref } from '@shared/protocol';

// Note: the command palette no longer lives in this entry. It runs in its
// own chrome-mounted overlay <browser> (palette.html) so the modal can
// cover the whole browser window. Show/hide is owned by chrome via a key
// binding in src/browser/base/content/bento-shell-mount.js.

function openSettings() {
  // Round-trip through bento-tools (which has reliable browser.tabs access)
  // because the chrome-mounted <browser remote=true remoteType=extension>
  // doesn't get the WebExtensions `browser` global injected, AND
  // window.open opens a new window not a tab (Firefox decides per user
  // prefs). Resolving the URL via location.origin keeps it relative to
  // bento-shell's UUID without needing to ask tools.
  const url = `${location.origin}/dist/settings.html`;
  dispatch({ type: 'tab/openUrl', url });
}

function openCommandPalette() {
  // Sidebar content can't directly call the chrome-side showPalette()
  // (cross-process). Use the same document.title IPC pattern as the
  // palette uses to signal close — chrome listens for DOMTitleChanged on
  // the bento-shell-frame and shows the palette when it sees this prefix.
  // Timestamp suffix ensures successive presses always fire the event
  // (no change = no event).
  const newTitle = `BENTO_OPEN_PALETTE_${Date.now()}`;
  console.log('[App] openCommandPalette: setting title to', newTitle);
  document.title = newTitle;
}

export function App() {
  const ready = useToolsReady();
  const activeWorkspaceColor = useWorkspacesStore((s) =>
    s.activeId ? s.byId[s.activeId]?.color : undefined,
  );
  // First-run welcome trigger. The settings snapshot lands a moment after
  // the tools port connects; once it does and welcomeSeen=false, signal
  // chrome to show the welcome overlay (chrome-mounted, full-window scrim
  // — implemented via the welcome.html overlay frame).
  //
  // Why the retry loop: requestWelcome() sets document.title =
  // BENTO_OPEN_WELCOME_<ts>, which the chrome poll picks up. But the
  // `panels/sync` event handler in useToolsPort ALSO writes document.title
  // (BENTO_PANELS:...) and lands moments later on cold boot — stomping
  // the welcome title before the 200ms chrome poll can see it. On
  // Alt+Shift+R there's no fresh panels broadcast so welcome wins on
  // first try. Five attempts × 200ms = 1s window covers the cold-boot
  // race; chrome's showWelcome() is idempotent so re-firing is a no-op
  // once it's visible. Loop stops automatically when welcomeSeen flips
  // true (effect cleanup) — no risk of looping forever.
  const welcomeShouldShow = useSettingsStore((s) => s.current !== null && !s.current.welcomeSeen);
  useEffect(() => {
    if (!welcomeShouldShow) return;
    let attempts = 0;
    const fire = () => {
      requestWelcome();
      attempts += 1;
      if (attempts >= 5) clearInterval(handle);
    };
    fire();
    const handle = setInterval(fire, 200);
    return () => clearInterval(handle);
  }, [welcomeShouldShow]);

  // Propagate the active workspace's accent palette to <html data-workspace-color>
  // so per-workspace accent tokens (declared in bento-tokens.css) cascade to
  // the entire shell.
  useEffect(() => {
    const html = document.documentElement;
    if (activeWorkspaceColor) html.setAttribute('data-workspace-color', activeWorkspaceColor);
    else html.removeAttribute('data-workspace-color');
  }, [activeWorkspaceColor]);

  const onActivate = (id: number) => dispatch({ type: 'tab/activate', id });
  const onClose = (id: number) => dispatch({ type: 'tab/close', id });
  const onOpenInSidePanel = (id: number) => dispatch({ type: 'panel/add', id });
  const uiColorMode = useSettingsStore((s) => s.current?.uiColorMode);
  const contentColorMode = useSettingsStore((s) => s.current?.contentColorMode);
  const sidebarCollapsed = useSettingsStore((s) => s.current?.sidebarCollapsed ?? false);
  const setUiColorMode = (next: ColorModePref) =>
    dispatch({ type: 'settings/update', changes: { uiColorMode: next } });
  const setContentColorMode = (next: ColorModePref) =>
    dispatch({ type: 'settings/update', changes: { contentColorMode: next } });
  const toggleSidebarCollapsed = () =>
    dispatch({ type: 'settings/update', changes: { sidebarCollapsed: !sidebarCollapsed } });

  // Mirror sidebarCollapsed onto the shell document's <html> via a data
  // attribute so CSS rules (TabRow, WorkspaceSwitcher, footer layout)
  // can react. The chrome side gets the same flag via title-IPC and
  // applies it to #bento-shell-host to actually shrink the rail.
  useEffect(() => {
    const html = document.documentElement;
    if (sidebarCollapsed) html.setAttribute('data-bento-collapsed', 'true');
    else html.removeAttribute('data-bento-collapsed');
  }, [sidebarCollapsed]);

  // Footer cross-fade. The footer's flex-direction snaps from row to
  // column-reverse when collapse toggles — discrete CSS property,
  // can't transition. To hide the snap behind a fade, snap opacity to
  // 0 SYNCHRONOUSLY before the browser paints (via useLayoutEffect),
  // then transition back to 1 on the next frame. The new layout is
  // never seen at full opacity — the first paint after the toggle is
  // already at opacity 0, then fades in.
  //
  // Duration is intentionally LONGER than the host-width transition
  // (200ms) so the buttons keep fading in after the rail has settled
  // — gives the eye time to register the new layout instead of
  // snapping into focus the instant the rail stops moving.
  //
  // Skip the very first run (when prevCollapsed.current is undefined)
  // so the boot doesn't briefly fade — initial render shows the
  // restored state without animation.
  const footerRef = useRef<HTMLDivElement>(null);
  const prevCollapsed = useRef<boolean | undefined>(undefined);
  useLayoutEffect(() => {
    const isFirstRun = prevCollapsed.current === undefined;
    const changed = prevCollapsed.current !== sidebarCollapsed;
    prevCollapsed.current = sidebarCollapsed;
    if (isFirstRun || !changed) return;
    const footer = footerRef.current;
    if (!footer) return;
    // Fade-in duration; matches a hypothetical --bento-duration-xslow.
    // If the design system grows that token later, swap this for a
    // getComputedStyle read on documentElement.
    const FADE_MS = 500;
    // Phase 1 (sync, pre-paint): instant opacity 0 with no transition.
    footer.style.transition = 'none';
    footer.style.opacity = '0';
    // Force style flush so the no-transition rule + opacity:0 land in
    // the same paint as the layout snap that triggered this effect.
    void footer.offsetWidth;
    // Phase 2 (post-paint): restore the transition and animate back to
    // 1. Two rAFs guarantee the previous frame committed before we
    // change the target value; without them the browser can collapse
    // both opacity assignments into a single paint and skip the fade.
    let rafA = 0;
    let rafB = 0;
    let cleanupTimer = 0;
    rafA = requestAnimationFrame(() => {
      rafB = requestAnimationFrame(() => {
        footer.style.transition = `opacity ${FADE_MS}ms ease`;
        footer.style.opacity = '1';
        cleanupTimer = window.setTimeout(() => {
          // Strip inline styles after the transition completes so any
          // future hover / class-based opacity rules can take over
          // without competing with stale inline values.
          footer.style.transition = '';
          footer.style.opacity = '';
        }, FADE_MS + 50);
      });
    });
    return () => {
      cancelAnimationFrame(rafA);
      cancelAnimationFrame(rafB);
      clearTimeout(cleanupTimer);
    };
  }, [sidebarCollapsed]);

  return (
    <Column gap="xs" className="bento-shell-app">
      <Row gap="xs" align="center" className="bento-shell-app__header">
        <WorkspaceSwitcher />
        {!ready && (
          <Text variant="text" size="xs" color="muted">
            connecting…
          </Text>
        )}
      </Row>
      <TabList onActivate={onActivate} onClose={onClose} onOpenInSidePanel={onOpenInSidePanel} />
      <Row ref={footerRef} gap="2xs" align="center" className="bento-shell-app__footer">
        {/* Collapse/expand toggle. DOM order matters: this is the FIRST
            child so flex-direction:column-reverse in collapsed mode pins
            it to the bottom of the vertical stack (= same on-screen
            position as the leftmost slot of the expanded horizontal row).
            That's the explicit UX requirement — clicking expand should
            land at the same cursor position as clicking collapse. */}
        <IconButton
          variant="ghost"
          size="sm"
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onPress={toggleSidebarCollapsed}
        >
          <Icon icon={sidebarCollapsed ? PanelLeftOpen : PanelLeftClose} />
        </IconButton>
        <IconButton
          variant="ghost"
          size="sm"
          aria-label="Open command palette (⌘⌥P)"
          onPress={openCommandPalette}
        >
          <Icon icon={Command} />
        </IconButton>
        <ColorModeCycle value={uiColorMode} onChange={setUiColorMode} surfaceLabel="Bento UI" />
        <ColorModeCycle
          value={contentColorMode}
          onChange={setContentColorMode}
          surfaceLabel="Website"
        />
        <IconButton variant="ghost" size="sm" aria-label="Settings" onPress={openSettings}>
          <Icon icon={Settings} />
        </IconButton>
      </Row>
    </Column>
  );
}

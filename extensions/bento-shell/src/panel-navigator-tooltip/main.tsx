import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Tooltip } from '@muxui/react';

import '../theme/muxui.css';

import '../theme/bento-tokens.css';
import '../theme/presets/index.css';
import '../theme/bento-fonts.css';
import '../theme/document-base.css';
import './tooltip.css';
import { useFirefoxTheme } from '../theme/useFirefoxTheme';
import { useWorkspaceTheme } from '../theme/useWorkspaceTheme';
import { initToolsPort } from '../bridge/useToolsPort';
import { useOverlayReadySignal } from '../bridge/overlayReady';

// Join the shell bus like every other shell document. The workspace and
// settings mirrors it hydrates feed useWorkspaceTheme and useFirefoxTheme below,
// so the tooltip follows the active theme and color mode instead of keeping the
// Default theme and the mode from boot.
initToolsPort();

interface NavigatorTooltipPayload {
  label: string;
  /** A second, smaller line under the label (the rail merge card's progress). */
  detail?: string;
  /** Where the tooltip sits against the anchor: below it (the navigator buttons) or beside it. */
  placement?: 'bottom' | 'end';
  screenX: number;
  screenY: number;
  width: number;
  height: number;
}

function PanelNavigatorTooltipApp() {
  useFirefoxTheme({ preferStoredSystemResolution: true });
  useWorkspaceTheme();
  const [payload, setPayload] = useState<NavigatorTooltipPayload | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { kind?: string; payload?: NavigatorTooltipPayload | null } | null;
      if (data?.kind !== 'bento-panel-navigator-tooltip') return;
      setPayload(data.payload ?? null);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  // After the listener above: chrome sends the pending label once this is announced.
  useOverlayReadySignal('panel-navigator-tooltip');

  if (!payload) return null;

  const left = payload.screenX - window.screenLeft;
  const top = payload.screenY - window.screenTop;

  return (
    <Tooltip
      content={
        payload.detail ? (
          <span className="bento-navigator-tooltip__text">
            <span className="bento-navigator-tooltip__label">{payload.label}</span>
            <span className="bento-navigator-tooltip__detail">{payload.detail}</span>
          </span>
        ) : (
          payload.label
        )
      }
      open={true}
      placement={payload.placement ?? 'bottom'}
      offset={8}
      trigger={
        <Button
          variant="ghost"
          size="sm"
          aria-hidden
          tabIndex={-1}
          style={{
            position: 'fixed',
            left,
            top,
            width: payload.width,
            height: payload.height,
            minWidth: 0,
            minHeight: 0,
            minInlineSize: 0,
            minBlockSize: 0,
            opacity: 0,
            pointerEvents: 'none',
            border: 0,
            background: 'transparent',
            padding: 0,
            margin: 0,
          }}
        />
      }
    />
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('bento-shell panel navigator tooltip: #root not found');

createRoot(container).render(
  <StrictMode>
    <PanelNavigatorTooltipApp />
  </StrictMode>,
);

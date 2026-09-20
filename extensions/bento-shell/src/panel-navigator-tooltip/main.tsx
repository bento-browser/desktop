import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Tooltip } from '@muxui/react';

import '../theme/muxui.css';

import '../theme/bento-tokens.css';
import '../theme/presets/index.css';
import '../theme/bento-fonts.css';
import { useFirefoxTheme } from '../theme/useFirefoxTheme';
import { useWorkspaceTheme } from '../theme/useWorkspaceTheme';

interface NavigatorTooltipPayload {
  label: string;
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

  if (!payload) return null;

  const left = payload.screenX - window.screenLeft;
  const top = payload.screenY - window.screenTop;

  return (
    <Tooltip
      content={payload.label}
      open={true}
      placement="bottom"
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

import { memo } from 'react';
import { Text } from '@tale-ui/react/text';
import { IconButton } from '@tale-ui/react/icon-button';
import { Icon } from '@tale-ui/react/icon';
// Per-icon import (no lucide-react barrel — see eslint config + §6.2).
import X from 'lucide-react/dist/esm/icons/x';

import { useTab } from '../../state/tabs';
import './TabRow.css';

export interface TabRowProps {
  id: number;
  active: boolean;
  onActivate: (id: number) => void;
  onClose: (id: number) => void;
}

function TabRowImpl({ id, active, onActivate, onClose }: TabRowProps) {
  const tab = useTab(id);
  if (!tab) return null;

  return (
    <div
      className={`bento-tab-row${active ? ' bento-tab-row--active' : ''}`}
      onClick={() => onActivate(id)}
    >
      {tab.favIconUrl ? (
        <img className="bento-tab-row__favicon" src={tab.favIconUrl} alt="" />
      ) : (
        <span className="bento-tab-row__favicon bento-tab-row__favicon--placeholder" />
      )}
      <Text variant="text" size="s" color={active ? 'default' : 'muted'}>
        {tab.title || 'Untitled'}
      </Text>
      <IconButton
        variant="ghost"
        size="sm"
        aria-label="Close tab"
        className="bento-tab-row__close"
        onPress={() => onClose(id)}
      >
        <Icon icon={X} />
      </IconButton>
    </div>
  );
}

export const TabRow = memo(TabRowImpl, (prev, next) => {
  return prev.id === next.id && prev.active === next.active;
});

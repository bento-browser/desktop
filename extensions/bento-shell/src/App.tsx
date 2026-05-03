import { Column } from '@tale-ui/react/column';
import { Row } from '@tale-ui/react/row';
import { Text } from '@tale-ui/react/text';

import { TabList } from './components/TabList/TabList';
import { dispatch, useToolsReady } from './bridge/useToolsPort';

export function App() {
  const ready = useToolsReady();

  const onActivate = (id: number) => dispatch({ type: 'tab/activate', id });
  const onClose = (id: number) => dispatch({ type: 'tab/close', id });

  return (
    <Column gap="xs" className="bento-shell-app">
      <Row gap="xs" align="center" className="bento-shell-app__header">
        <Text variant="label" size="s">
          Bento
        </Text>
        {!ready && (
          <Text variant="text" size="xs" color="muted">
            connecting…
          </Text>
        )}
      </Row>
      <TabList onActivate={onActivate} onClose={onClose} />
    </Column>
  );
}

// Shown instead of the board when tools could not read the stored bookmarks (`status:
// 'loadFailed'`). Tools refuses every change and writes nothing while the load has failed, so an
// editable board would look like it saves and not. Retry asks for the snapshot again, which makes
// tools read the storage once more.

import { useEffect, useState } from 'react';
import { Button, Text } from '@muxui/react';
import type { BookmarksSnapshot } from '@shared/protocol';

export interface LoadFailedProps {
  /** The failed snapshot: a new one (the retry failed again, or succeeded) ends the wait. */
  snapshot: BookmarksSnapshot;
  onRetry: () => void;
  onClose: () => void;
}

export function LoadFailed({ snapshot, onRetry, onClose }: LoadFailedProps) {
  const [retrying, setRetrying] = useState(false);
  useEffect(() => setRetrying(false), [snapshot]);
  return (
    <div className="bento-bookmarks__empty bento-bookmarks__failed" role="alert">
      <div className="bento-bookmarks__empty-box bento-bookmarks__empty-box--notice">
        <Text variant="label" size="md">
          {"Bookmarks couldn't load"}
        </Text>
        <Text variant="body" size="sm" color="muted">
          Your saved bookmarks have not been changed. Nothing can be edited until they load.
        </Text>
        <div className="bento-bookmarks__empty-actions">
          <Button
            variant="primary"
            size="sm"
            onActivate={() => {
              if (retrying) return;
              setRetrying(true);
              onRetry();
            }}
          >
            {retrying ? 'Retrying' : 'Retry'}
          </Button>
          <Button variant="ghost" size="sm" onActivate={onClose}>
            Back to browser
          </Button>
        </div>
      </div>
    </div>
  );
}

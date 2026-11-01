// The flat result list shown instead of the boards while the search field holds text: every space
// searched, matches grouped by space and group. A result opens like a row of a column.

import { Button, Text } from '@muxui/react';

import { Favicon } from './ItemRow';
import { hostnameOf, itemLabel, type SearchHit } from './model';

export interface SearchResultsProps {
  query: string;
  hits: SearchHit[];
  onOpen: (id: string, where: 'panel' | 'tab') => void;
}

export function SearchResults({ query, hits, onOpen }: SearchResultsProps) {
  if (hits.length === 0) {
    return (
      <div className="bento-bookmarks__results bento-bookmarks__results--empty">
        <Text variant="body" size="sm" color="muted">
          {`Nothing matches "${query.trim()}".`}
        </Text>
      </div>
    );
  }
  return (
    <div className="bento-bookmarks__results" role="list" aria-label="Search results">
      {hits.map(({ space, group, items }) => (
        <section key={group.id} className="bento-bookmarks__result-group" aria-label={group.name}>
          <header className="bento-bookmarks__result-head">
            <span className="bento-bookmarks__dot" data-bm-color={group.color} />
            <Text variant="label" size="sm">
              {space.name}
            </Text>
            <Text variant="body" size="sm" color="muted">
              {group.name}
            </Text>
            <Text variant="body" size="sm" color="muted" className="bento-bookmarks__count">
              {items.length}
            </Text>
          </header>
          {items.map((item) =>
            item.kind === 'link' ? (
              <div key={item.id} role="listitem" className="bento-bookmarks__row">
                <Button
                  variant="ghost"
                  size="sm"
                  className="bento-bookmarks__row-main"
                  title={item.url}
                  onActivate={() => onOpen(item.id, 'panel')}
                >
                  <Favicon src={item.favIconUrl} />
                  <span className="bento-bookmarks__row-text">
                    <Text variant="body" size="sm" truncate>
                      {itemLabel(item)}
                    </Text>
                    <Text variant="body" size="xs" color="muted" truncate>
                      {hostnameOf(item.url)}
                    </Text>
                  </span>
                </Button>
              </div>
            ) : (
              <div
                key={item.id}
                role="listitem"
                className="bento-bookmarks__row"
                data-kind={item.kind}
              >
                <Text variant="body" size="sm" className="bento-bookmarks__note-text">
                  {item.kind === 'todo' ? `${item.done ? 'Done: ' : ''}${item.text}` : item.text}
                </Text>
              </div>
            ),
          )}
        </section>
      ))}
    </div>
  );
}

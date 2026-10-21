import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MergeProgressCard, MergeProgressCardView } from './MergeProgressCard';
import type { MergeProgressCardModel } from './mergeProgressCardModel';
import { getThemeScopeAttributes } from '../../theme/themeScope';

// A dark card, as on a light sidebar.
const scope = getThemeScopeAttributes('default', 'dark');

const model = (overrides: Partial<MergeProgressCardModel> = {}): MergeProgressCardModel => ({
  kind: 'active',
  percent: 20,
  title: 'Importing from Firefox',
  detail: 'Work, 120 of 608 tabs',
  host: 'github.com',
  dismissible: false,
  announcement: 'Importing from Firefox',
  ...overrides,
});

const done = model({
  kind: 'done',
  percent: 100,
  title: 'Imported 608 tabs',
  detail: 'From Firefox, 6 spaces',
  host: null,
  dismissible: true,
});

const render = (m: MergeProgressCardModel, rail = false) =>
  renderToStaticMarkup(
    <MergeProgressCardView
      model={m}
      scope={scope}
      rail={rail}
      onOpen={() => {}}
      onDismiss={() => {}}
    />,
  );

/** Markup of the card's primary button: from its tag to its first closing tag. */
function primaryButton(markup: string): string {
  const start = markup.indexOf('<button');
  return markup.slice(start, markup.indexOf('</button>', start));
}

describe('MergeProgressCardView', () => {
  it('a running import has no dismiss button and a determinate ring', () => {
    const markup = render(model());
    expect(markup).toContain('data-kind="active"');
    expect(markup).not.toContain('aria-label="Dismiss"');
    expect(markup).toContain('aria-valuenow="20"');
    expect(markup).toContain('Importing from Firefox');
    expect(markup).toContain('Work, 120 of 608 tabs');
    expect(markup).toContain('github.com');
  });

  it('a ring before the totals is still, at 0, never indeterminate', () => {
    const markup = render(model({ percent: 0, detail: null, host: null }));
    expect(markup).toContain('aria-valuenow="0"');
    expect(markup).not.toContain('data-indeterminate');
  });

  it.each(['done', 'cancelled', 'failed'] as const)('%s has one dismiss button', (kind) => {
    const markup = render(model({ ...done, kind }));
    expect(markup).toContain(`data-kind="${kind}"`);
    expect(markup.match(/aria-label="Dismiss"/g)).toHaveLength(1);
  });

  it('keeps the dismiss button out of the primary button, so buttons do not nest', () => {
    const markup = render(done);
    expect(primaryButton(markup)).not.toContain('Dismiss');
    expect(markup.indexOf('aria-label="Dismiss"')).toBeGreaterThan(markup.indexOf('</button>'));
  });

  it('names the primary button by the title and describes it by the detail and host', () => {
    const button = primaryButton(render(model()));
    expect(button).toMatch(/aria-labelledby="[^"]+"/);
    expect(button).toMatch(/aria-describedby="[^"]+ [^"]+"/);
    expect(primaryButton(render(model({ detail: null, host: null })))).not.toContain(
      'aria-describedby',
    );
  });

  it('shows the percentage inside a partial ring only', () => {
    expect(render(model())).toContain('bento-merge-card__ring-value');
    expect(render(model({ percent: 0 }))).not.toContain('bento-merge-card__ring-value');
    expect(render(model({ percent: 100 }))).not.toContain('bento-merge-card__ring-value');
    expect(render(done)).not.toContain('bento-merge-card__ring-value');
  });

  it('has no native title in the rail: the tooltip overlay carries the text', () => {
    const cancelled = model({
      kind: 'cancelled',
      title: 'Import cancelled',
      detail: '120 tabs added',
    });
    expect(render(cancelled, true)).not.toContain('title=');
  });

  it('puts the theme scope on the card root, all three attributes together', () => {
    const root = render(model()).split('>')[0] ?? '';
    expect(root).toContain('class="bento-sidebar-card bento-merge-card"');
    expect(root).toContain('data-muxui-theme="default"');
    expect(root).toContain('data-muxui-color-scheme="dark"');
    expect(root).toContain('data-muxui-contrast="standard"');
  });

  it('marks an exiting card', () => {
    const markup = renderToStaticMarkup(
      <MergeProgressCardView
        model={done}
        scope={scope}
        exiting
        onOpen={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(markup).toContain('data-exiting=""');
  });
});

describe('MergeProgressCard', () => {
  it('renders only an empty polite status while no merge is running or ended', () => {
    const markup = renderToStaticMarkup(<MergeProgressCard onOpen={() => {}} />);
    expect(markup).toBe('<div role="status" class="bento-visually-hidden"></div>');
  });
});
